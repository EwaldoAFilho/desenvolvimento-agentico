import type { CompiledGraph } from '@agentic/compiler'
import type {
  GateId,
  MissionId,
  MissionPlannerRegistry,
  MissionProposal,
  PlanningCapabilities,
  PlanningContext,
  PlanningFailure,
  PlanningFailureCode,
  PlanningRequest,
  PlanProblem,
  PlanRevision,
  ProviderId,
  Run,
} from '@agentic/domain'
import { MAX_PLAN_REVISIONS } from '@agentic/domain'
import type { CompileReportDto, DiagnosticDto, ProjectFile } from '@agentic/schemas'
import { CommandRefusedError, engineEvent, humanActor } from '../engine/index.js'
import { compileMission, toCompileReport } from './compile.js'
import type { ApplicationDeps } from './deps.js'
import { canonicalMissionSpec, missionYamlOf } from './mission-yaml.js'
import { createRun } from './run-lifecycle.js'

/**
 * PlanMission: texto livre -> missao gravada pelo control plane -> rascunho compilado.
 *
 * Tres regras dao forma ao caso de uso, e nenhuma delas e detalhe de implementacao:
 *
 *  - **quem escreve o arquivo e o control plane.** O planejador devolve `MissionSpec`; a
 *    serializacao, o caminho e a versao do formato sao nossos (ADR-0016 2).
 *  - **o repositorio e conferido depois da chamada.** Planejar e leitura. Se a arvore mudou
 *    enquanto o planejador rodava, o planejamento falha explicado e NADA e gravado — a
 *    garantia e o diff que medimos, nao a promessa do modo da CLI (ADR-0016).
 *  - **o reparo e curto.** Duas correcoes e a decisao volta ao humano (P15). Correcao que
 *    repete um plano ja recusado encerra o ciclo antes: insistir so gastaria assinatura.
 *
 * O que sai daqui e sempre `DRAFT`. Aprovar continua sendo ato humano registrado, e este
 * caminho nao tem afordancia para pular essa etapa.
 */

export const DEFAULT_PLANNING_TIMEOUT_MS = 10 * 60_000

/** Quanto do pedido do humano fica registrado na nota do run. */
const MAX_NOTE_PROMPT_CHARS = 400

/**
 * Falha do PROCESSO nao entra em ciclo de reparo: CLI ausente, tempo esgotado, cancelamento
 * e saida diferente de zero nao sao um plano errado para corrigir — sao um planejamento que
 * nao aconteceu. Pedir "correcao" ali seria repetir a chamada as cegas, gastando assinatura.
 */
const REPAIRABLE: ReadonlySet<PlanningFailureCode> = new Set<PlanningFailureCode>([
  'NO_PROPOSAL',
  'CONTRACT_REJECTED',
])

/**
 * Onde o artefato da missao mora. Porta: o caso de uso nao conhece disco, e a suite exercita
 * o ciclo inteiro sem repositorio nenhum.
 */
export interface MissionArtifactStore {
  /** Caminho do artefato, relativo a raiz do projeto. */
  pathFor(missionId: MissionId): string
  /** Ids de missao ja ocupados no repositorio: a proposta nao pode colidir com eles. */
  taken(): Promise<readonly MissionId[]>
  /**
   * Grava. RECUSA se o arquivo ja existir — sobrescrever em silencio o plano de outra pessoa
   * e exatamente o que nao pode acontecer.
   */
  create(missionId: MissionId, text: string): Promise<void>
}

/** Erro de `create` quando o artefato ja existe. */
export class MissionFileExistsError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`o arquivo de missao ${path} ja existe e nao sera sobrescrito`)
    this.name = 'MissionFileExistsError'
    this.path = path
  }
}

/**
 * Como o control plane OBSERVA o repositorio antes e depois de acionar o planejador. Duas
 * leituras iguais sao a evidencia de que planejar nao alterou arquivo; `undefined` e a
 * ausencia de observacao, que nao vale como prova de coisa nenhuma.
 */
export interface RepoObserver {
  fingerprint(): Promise<string | undefined>
}

export interface ProjectSourceText {
  readonly projectText: string
  readonly gatesText: string
}

export interface PlanningDeps {
  readonly planners: MissionPlannerRegistry
  readonly missions: MissionArtifactStore
  readonly repo: RepoObserver
  /** Compilar e funcao pura sobre o CONTEUDO dos tres arquivos (ARCHITECTURE 7). */
  sources(): Promise<ProjectSourceText>
  readonly project: ProjectFile
  readonly gates: readonly GateId[]
  /** Raiz que o planejador pode LER. Nao e workspace: sem lease, sem branch, sem commit base. */
  readonly readRoot: string
  readonly timeoutMs: number
}

export interface PlanMissionInput {
  readonly prompt: string
  /** Ausente: o padrao do projeto. Com um so planejador, escolher e desnecessario. */
  readonly plannerId?: ProviderId
  readonly actor: string
  /** Explicito e obrigatorio: acionar planejador real gasta a assinatura do usuario (P17). */
  readonly acceptsSubscriptionUse: boolean
  readonly timeoutMs?: number
}

export interface PlannedMission {
  readonly outcome: 'planned'
  readonly missionId: MissionId
  /** Artefato gravado pelo control plane, relativo a raiz do projeto. */
  readonly file: string
  readonly plannerId: ProviderId
  /** Quantas correcoes foram necessarias. `0` = acertou de primeira. */
  readonly revisions: number
  readonly run: Run
  readonly report: CompileReportDto
  readonly rationale?: string
}

export interface RefusedPlanning {
  readonly outcome: 'refused'
  readonly plannerId: ProviderId
  readonly revisions: number
  readonly failure: PlanningFailure
}

export type PlanMissionResult = PlannedMission | RefusedPlanning

/** Quem vai planejar. Sem planejador configurado nao ha o que recusar: nao ha o que chamar. */
function chosenPlanner(
  planners: MissionPlannerRegistry,
  asked: ProviderId | undefined,
): ProviderId {
  const available = planners.list()
  if (asked === undefined) {
    const fallback = planners.default()
    if (fallback === undefined) {
      throw new CommandRefusedError(
        'nenhum planejador configurado: planejar exige uma CLI local de agente declarada no projeto',
      )
    }
    return fallback
  }
  if (!available.some((id) => String(id) === String(asked))) {
    throw new CommandRefusedError(
      `planejador ${asked} nao existe; disponiveis: ${available.join(', ') || '(nenhum)'}`,
    )
  }
  return asked
}

function refusal(
  plannerId: ProviderId,
  revisions: number,
  failure: PlanningFailure,
): RefusedPlanning {
  return { outcome: 'refused', plannerId, revisions, failure }
}

function failure(
  code: PlanningFailureCode,
  message: string,
  problems: readonly PlanProblem[] = [],
): PlanningFailure {
  return { code, message, problems }
}

/** Diagnostico do compilador no vocabulario do planejador: onde errou e o que consertar. */
function problemsOfDiagnostics(diagnostics: readonly DiagnosticDto[]): PlanProblem[] {
  return diagnostics
    .filter((item) => item.severity === 'ERROR')
    .map((item) => ({
      path: item.targets.join(', '),
      message: `${item.code}: ${item.message} — ${item.hint}`,
    }))
}

interface AcceptedPlan {
  readonly ok: true
  readonly missionText: string
  readonly report: CompileReportDto
  readonly graph: CompiledGraph
}

interface RejectedPlan {
  readonly ok: false
  readonly problems: readonly PlanProblem[]
  /** O plano que NOS geramos, para o proximo ciclo de reparo. */
  readonly missionText?: string
}

/**
 * O plano proposto vira arquivo e passa pelo COMPILADOR antes de qualquer escrita. E o
 * compilador quem sabe se o gate existe, se `touches` cai em `denyPaths`, se ha ciclo ou
 * fase nao declarada — reimplementar essas regras aqui criaria um segundo juiz para
 * divergir do primeiro. Nada e gravado enquanto restar um ERROR.
 */
async function checkProposal(
  planning: PlanningDeps,
  proposal: MissionProposal,
  header: readonly string[],
): Promise<AcceptedPlan | RejectedPlan> {
  const mission = proposal.mission
  const taken = await planning.missions.taken()
  if (taken.some((id) => String(id) === String(mission.id))) {
    return {
      ok: false,
      problems: [
        {
          path: 'id',
          message: `a missao ${mission.id} ja existe em ${planning.missions.pathFor(mission.id)}; proponha outro id`,
        },
      ],
    }
  }

  const serialized = missionYamlOf(mission, header)
  if (!serialized.ok) return { ok: false, problems: serialized.problems }

  const sources = await planning.sources()
  const result = compileMission({
    missionText: serialized.text,
    projectFile: sources.projectText,
    gatesFile: sources.gatesText,
  })
  const report = toCompileReport(result, serialized.text)
  if (result.graph === undefined || !report.ok) {
    return {
      ok: false,
      problems: problemsOfDiagnostics(report.diagnostics),
      missionText: serialized.text,
    }
  }
  return { ok: true, missionText: serialized.text, report, graph: result.graph }
}

function contextOf(planning: PlanningDeps, taken: readonly MissionId[]): PlanningContext {
  const policies = planning.project.policies
  return {
    readRoot: planning.readRoot,
    takenMissionIds: taken,
    availableGates: planning.gates,
    constraints: constraintsOf(planning.project),
    denyPaths: policies.denyPaths,
  }
}

/**
 * Restricoes do projeto sao FATOS da configuracao, nao conselhos: cada linha aqui e algo que
 * o compilador vai cobrar depois. Dizer ao planejador o que ja esta declarado evita gastar
 * uma das duas correcoes com um erro que o projeto anunciava.
 */
function constraintsOf(project: ProjectFile): string[] {
  const execution = project.execution
  const constraints = [
    `workspace do projeto: ${execution.workspace}`,
    `no maximo ${execution.maxParallelTasks} task(s) em paralelo`,
    `revisao padrao: ${project.policies.review.default}`,
  ]
  if (project.policies.enforceTouches) {
    constraints.push('escopo de escrita e cobrado: toda task que altera codigo declara touches')
  }
  if (execution.workspace === 'shared' && execution.maxParallelTasks > 1) {
    constraints.push('arvore compartilhada: tasks concorrentes nao podem tocar os mesmos caminhos')
  }
  return constraints
}

interface CycleAccepted {
  readonly outcome: 'accepted'
  readonly proposal: MissionProposal
  readonly plan: AcceptedPlan
  readonly revisions: number
}

interface CycleRefused {
  readonly outcome: 'refused'
  readonly failure: PlanningFailure
  readonly revisions: number
}

type CycleResult = CycleAccepted | CycleRefused

/**
 * O ciclo: propor, conferir, pedir correcao — no maximo `MAX_PLAN_REVISIONS` vezes. Um
 * planejador que nao aceita correcao tem zero credito, e a decisao volta ao humano na
 * primeira recusa em vez de a chamada ser repetida sem nada de novo no pedido.
 */
async function runPlanningCycle(
  planning: PlanningDeps,
  input: PlanMissionInput,
  plannerId: ProviderId,
  capabilities: PlanningCapabilities,
  header: readonly string[],
): Promise<CycleResult> {
  const planner = planning.planners.get(plannerId)
  const before = await planning.repo.fingerprint()
  if (before === undefined) {
    return {
      outcome: 'refused',
      revisions: 0,
      failure: failure(
        'PLANNER_FAILED',
        'nao foi possivel observar o repositorio antes de planejar; sem observacao o control ' +
          'plane nao tem como afirmar que o planejamento nao alterou arquivo',
      ),
    }
  }

  const takenBefore = await planning.missions.taken()
  const context = contextOf(planning, takenBefore)
  const budget = capabilities.acceptsRevision ? MAX_PLAN_REVISIONS : 0
  const seen = new Set<string>()
  let revision: PlanRevision | undefined
  let revisions = 0

  for (;;) {
    const request: PlanningRequest = {
      prompt: input.prompt,
      context,
      timeoutMs: input.timeoutMs ?? planning.timeoutMs,
      ...(revision === undefined ? {} : { revision }),
    }
    const result = await planner.plan(request)

    const untouched = await unchangedRepo(planning, before)
    if (untouched !== undefined) return { outcome: 'refused', failure: untouched, revisions }

    let problems: readonly PlanProblem[]
    let previous: string

    if (result.outcome === 'refused') {
      if (!REPAIRABLE.has(result.failure.code)) {
        return { outcome: 'refused', failure: result.failure, revisions }
      }
      problems = result.failure.problems
      previous = result.failure.raw ?? ''
    } else {
      const canonical = canonicalMissionSpec(result.proposal.mission)
      if (seen.has(canonical)) {
        return {
          outcome: 'refused',
          revisions,
          failure: failure(
            'PLAN_UNCHANGED',
            'a correcao repetiu um plano ja recusado; insistir so gastaria assinatura',
          ),
        }
      }
      seen.add(canonical)
      const checked = await checkProposal(planning, result.proposal, header)
      if (checked.ok) {
        return { outcome: 'accepted', proposal: result.proposal, plan: checked, revisions }
      }
      problems = checked.problems
      previous = checked.missionText ?? ''
    }

    if (revisions >= budget) {
      return {
        outcome: 'refused',
        revisions,
        failure: failure(
          'REVISIONS_EXHAUSTED',
          budget === 0
            ? `o planejador ${plannerId} nao aceita ciclo de correcao: a decisao volta ao humano`
            : `o ciclo de reparo permite ${MAX_PLAN_REVISIONS} correcoes e elas acabaram: a decisao volta ao humano`,
          problems,
        ),
      }
    }
    revisions += 1
    revision = { attempt: revisions, previous, problems }
  }
}

/**
 * `undefined` quando a arvore continua como estava; a falha explicada quando nao continua.
 *
 * A mensagem diz que o REPOSITORIO mudou, e nao que o planejador o alterou: o que medimos
 * foram duas leituras diferentes em volta da chamada, e nada nessa medida distingue o
 * planejador de um editor aberto na outra janela. Afirmar o culpado seria afirmar o que nao
 * foi observado — e a consequencia (nada e gravado) e a mesma nos dois casos.
 */
async function unchangedRepo(
  planning: PlanningDeps,
  before: string,
): Promise<PlanningFailure | undefined> {
  const after = await planning.repo.fingerprint()
  if (after === before) return undefined
  return failure(
    'PLANNER_FAILED',
    after === undefined
      ? 'o repositorio deixou de ser observavel durante o planejamento; nada foi gravado'
      : 'o repositorio mudou durante o planejamento, e planejar e leitura; nada foi gravado',
  )
}

function headerFor(plannerId: ProviderId, actor: string): string[] {
  return [
    `Missao proposta por ${plannerId} e gravada pelo control plane a pedido de ${actor}.`,
    'Rascunho: nada foi aprovado nem executado. Revise, edite e aprove quando quiser.',
  ]
}

function noteFor(prompt: string, plannerId: ProviderId, revisions: number): string {
  const excerpt =
    prompt.length <= MAX_NOTE_PROMPT_CHARS ? prompt : `${prompt.slice(0, MAX_NOTE_PROMPT_CHARS)}...`
  const corrections = revisions === 1 ? '1 correcao' : `${revisions} correcoes`
  return `plano proposto por ${plannerId} apos ${corrections}, a partir do pedido: ${excerpt}`
}

/**
 * Texto livre vira missao gravada e compilada. Nada aqui aprova: o run nasce `DRAFT` e o
 * proximo passo continua sendo humano.
 */
export async function planMission(
  deps: ApplicationDeps,
  planning: PlanningDeps,
  input: PlanMissionInput,
): Promise<PlanMissionResult> {
  const prompt = input.prompt.trim()
  if (prompt.length === 0) {
    throw new CommandRefusedError('planejar exige o pedido do humano em texto livre')
  }
  const actor = input.actor.trim()
  if (actor.length === 0) {
    throw new CommandRefusedError('planejar exige o autor humano')
  }
  // Aparado UMA vez: daqui para baixo ninguem precisa lembrar de aparar de novo.
  const asked: PlanMissionInput = { ...input, prompt, actor }

  const plannerId = chosenPlanner(planning.planners, input.plannerId)
  const capabilities = planning.planners.get(plannerId).capabilities()
  if (!capabilities.simulated && !input.acceptsSubscriptionUse) {
    throw new CommandRefusedError(
      `planejar com ${plannerId} aciona a CLI local do usuario e consome a assinatura dele: ` +
        'exige aceite explicito',
    )
  }

  const header = headerFor(plannerId, actor)
  const cycle = await runPlanningCycle(planning, asked, plannerId, capabilities, header)
  if (cycle.outcome === 'refused') return refusal(plannerId, cycle.revisions, cycle.failure)

  const mission = cycle.proposal.mission
  try {
    await planning.missions.create(mission.id, cycle.plan.missionText)
  } catch (error) {
    if (error instanceof MissionFileExistsError) {
      return refusal(
        plannerId,
        cycle.revisions,
        failure('CONTRACT_REJECTED', error.message, [{ path: 'id', message: error.message }]),
      )
    }
    throw error
  }

  const run = await createRun(deps, {
    mission,
    compiled: cycle.plan.graph,
    project: planning.project,
    missionText: cycle.plan.missionText,
  })
  await recordRequest(deps, run, actor, noteFor(prompt, plannerId, cycle.revisions))

  return {
    outcome: 'planned',
    missionId: mission.id,
    file: planning.missions.pathFor(mission.id),
    plannerId,
    revisions: cycle.revisions,
    run,
    report: cycle.plan.report,
    ...(cycle.proposal.rationale === undefined ? {} : { rationale: cycle.proposal.rationale }),
  }
}

/**
 * Quem pediu o plano fica na linha do tempo do run. Nao e transicao de estado — e o registro
 * de que este rascunho nasceu de um pedido humano, e de qual.
 */
async function recordRequest(
  deps: ApplicationDeps,
  run: Run,
  actor: string,
  note: string,
): Promise<void> {
  const now = deps.clock.now()
  await deps.store.withTransaction(async (uow) => {
    await uow.appendEvent(
      engineEvent(run.id, now, 'human.note_added', { actor, note }, { actor: humanActor(actor) }),
    )
  })
}
