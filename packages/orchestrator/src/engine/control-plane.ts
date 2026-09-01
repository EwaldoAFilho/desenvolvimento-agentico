import { resolve } from 'node:path'
import nodeProcess from 'node:process'
import type { CompiledGraph } from '@agentic/compiler'
import {
  type AgentProfile,
  type AgentRole,
  type Clock,
  type IdGenerator,
  type Integrator,
  isRecoverableActiveRunStatus,
  isRunId,
  isRunStatus,
  type MissionSpec,
  type ProviderRegistry,
  RECOVERABLE_ACTIVE_RUN_STATUSES,
  type Run,
  type RunId,
  type RunStatus,
  type TaskId,
  agentProfileId as toAgentProfileId,
  providerId as toProviderId,
} from '@agentic/domain'
import { type GateProfiles, GateRunner, loadGateProfiles } from '@agentic/gates'
import { canonicalIfPresent, openPersistence, type Persistence } from '@agentic/persistence'
import {
  createProviderRegistryFromProject,
  type MockScript,
  type ProviderFactory,
} from '@agentic/providers'
import type { GatesFile, ProjectFile, RunSnapshot, TaskDetail } from '@agentic/schemas'
import {
  GitIntegrator,
  GitWorktreeWorkspaceProvider,
  SharedWorkspaceProvider,
} from '@agentic/workspace'
import {
  type ApplicationDeps,
  type ApproveMissionInput,
  approveMission,
  type CompileInput,
  type CompileResult,
  type CreateRunInput,
  compileMission,
  createRun,
  generateMissionReport,
  getRunSnapshot,
  getTaskDetail,
  loadMissionSpec,
  loadRun,
  type MissionReport,
  pauseRun,
  resumeRun,
  retryTask,
  type StartRunInput,
  skipTask,
  startRun,
  stopRun,
  unblockTask,
  validateMission,
} from '../application/index.js'
import { systemClock } from '../runtime/clock.js'
import { ulidGenerator } from '../runtime/ids.js'
import type { AgentLogConfig } from './agent-log.js'
import { CommandRefusedError } from './errors.js'
import { SharedTreeIntegrator } from './integration.js'
import {
  type HumanCommand,
  Orchestrator,
  type TaskCommandInput,
  type UnblockInput,
} from './orchestrator.js'
import type {
  AttemptWorkspaceProvider,
  EngineDeps,
  GateExecutor,
  MissionWorkspaceProvider,
} from './types.js'

/** Allowlist minima para o processo do agente. Nenhuma credencial e injetada (P17). */
export const DEFAULT_AGENT_ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR'] as const

/** Um run que passou a ter dono nesta instancia (ou que ja tinha). */
export interface RunAdoption {
  readonly runId: RunId
  readonly status: RunStatus
  /** `true` = a instancia ja era dona; a chamada nao criou orquestrador nenhum (I13). */
  readonly alreadyOwned: boolean
}

/** Run recuperavel que NAO ganhou dono, com o motivo — silencio aqui seria pior que a falha. */
export interface RunAdoptionRefusal {
  readonly runId: RunId
  readonly status: RunStatus
  readonly reason: string
}

export interface AdoptionResult {
  readonly adopted: readonly RunAdoption[]
  readonly refused: readonly RunAdoptionRefusal[]
}

/**
 * O que o control plane precisa saber da posse do projeto (I14): quem somos, O QUE possuimos
 * e se ainda possuimos. Nada de adquirir ou soltar — isso e do processo que fez o boot.
 * `ControlPlaneLease` de `@agentic/persistence` satisfaz esta forma.
 *
 * `ownedDir` nao e informativo: e o que amarra a posse ao projeto. Sem ele, um lease legitimo
 * de `/repo-A` autorizava um plane aberto sobre `/repo-B` — "ter algum lease" nao prova posse
 * DESTE projeto, e o control plane de B disputaria a propria posse sem saber que ja havia
 * outro escritor.
 */
export interface OwnershipLease {
  readonly instanceId: string
  /** Diretorio de estado que este lease protege — o `.agentic` canonico do projeto. */
  readonly ownedDir: string
  readonly held: boolean
}

export interface ControlPlaneConfig {
  readonly project: ProjectFile
  readonly gatesFile: GatesFile
  /** Raiz do repositorio alvo. Default: `project.project.repoRoot`. */
  readonly repoRoot?: string
  readonly baseDir?: string
  readonly databasePath?: string
  readonly clock?: Clock
  readonly ids?: IdGenerator
  readonly registry?: ProviderRegistry
  /** Roteiros dos providers in-process, por id — o caminho de teste sem LLM. */
  readonly scripts?: Readonly<Record<string, MockScript>>
  /** Substitui a construcao de um provider — usado pela suite para roteiros por tentativa. */
  readonly providerFactories?: Readonly<Record<string, ProviderFactory>>
  readonly gateRunner?: GateExecutor
  readonly agentEnvAllow?: readonly string[]
  /** Teto, redacao e espera do log do agente gravado por tentativa (ARCHITECTURE 6.1). */
  readonly agentLog?: AgentLogConfig
  readonly safetyIntervalMs?: number
  /**
   * Posse do projeto (I14). Presente = este plane pode MUTAR, enquanto for o dono.
   *
   * Ausente = plane de LEITURA. Ele abre o banco e responde consultas, mas `createRun`,
   * `approveMission`, `startRun`, `open` e `adoptRecoverableRuns` recusam — a ausencia e
   * recusa, nunca permissao. Quem precisa mutar (`startServer`, `mission start`,
   * `mission approve`) disputa a posse ANTES e passa o lease aqui.
   */
  readonly lease?: OwnershipLease
}

export interface ControlPlane {
  readonly persistence: Persistence
  /** Identidade do dono, quando este plane tem posse. Liga a posse a descoberta. */
  readonly instanceId?: string
  readonly registry: ProviderRegistry
  readonly gates: GateProfiles
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly deps: ApplicationDeps
  validateMission(input: CompileInput): ReturnType<typeof validateMission>
  compileMission(input: CompileInput): CompileResult
  createRun(input: Omit<CreateRunInput, 'project'> & { project?: ProjectFile }): Promise<Run>
  approveMission(input: ApproveMissionInput): Promise<Run>
  startRun(input: StartRunInput): Promise<Run>
  pauseRun(runId: RunId, command: HumanCommand): Promise<void>
  resumeRun(runId: RunId, command: HumanCommand): Promise<void>
  stopRun(runId: RunId, command: HumanCommand): Promise<void>
  unblockTask(runId: RunId, command: UnblockInput): Promise<void>
  retryTask(runId: RunId, command: TaskCommandInput): Promise<void>
  skipTask(runId: RunId, command: TaskCommandInput & { readonly reason: string }): Promise<void>
  cancelTask(runId: RunId, command: TaskCommandInput): Promise<void>
  getRunSnapshot(runId: RunId): Promise<RunSnapshot>
  getTaskDetail(runId: RunId, taskId: TaskId): Promise<TaskDetail>
  generateMissionReport(runId: RunId): Promise<MissionReport>
  open(runId: RunId): Promise<Orchestrator>
  adoptRecoverableRuns(): Promise<AdoptionResult>
  close(): Promise<void>
}

/**
 * O que uma leitura pode chamar em cada store da persistencia.
 *
 * Recusar so na fachada (`plane.createRun`) nao bastava: `plane.persistence` e publico, e
 * `plane.persistence.runs.createRun(...)` chegava ao banco sem passar por guarda nenhuma.
 * Nenhum handler de producao fazia isso hoje — e "hoje" e exatamente a palavra de que uma
 * invariante nao pode depender.
 *
 * A lista e de LEITURAS, nao de escritas, e a inversao e o ponto. Uma lista de bloqueios
 * envelhece em silencio — `runs.commit` e `runs.withRecoveryTransaction` escrevem tanto
 * quanto `withTransaction` e passariam por omissao. Com allowlist, o default e RECUSA, a
 * mesma regra que 003B aplicou a posse; uma leitura nova esquecida falha alto, no teste.
 */
const LEITURAS_DA_PERSISTENCIA = {
  runs: ['loadRun', 'listRuns', 'loadTaskRuns', 'loadAttempts', 'loadAttempt', 'listLocks'],
  events: ['list', 'listSync', 'latestSeq', 'count', 'subscribe', 'close'],
  artifacts: [
    'read',
    'readText',
    'readById',
    'get',
    'getByPath',
    'list',
    'toRecord',
    'runDirectory',
    'resolvePath',
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>

/**
 * As portas que entregam a CONEXAO crua, por onde qualquer SQL passa sem allowlist nenhuma.
 *
 * Bloquear so metodos deixava `plane.persistence.database.db.prepare('UPDATE runs ...')`
 * — e o mesmo handle sai por `runs.db`, `events.db`, `artifacts.db` e `queries.db`. Um
 * espelho que fecha os metodos e deixa a porta dos fundos aberta nao e somente-leitura: e
 * uma afirmacao falsa, que e pior que a ausencia dela.
 */
const PORTAS_DA_CONEXAO = ['db'] as const
const PORTA_DA_PERSISTENCIA = ['database'] as const

interface RegrasDeAcesso {
  /** Metodos permitidos sem posse. `undefined` = todos os metodos deste alvo sao leitura. */
  readonly leituras?: readonly string[]
  /** Propriedades que entregam a conexao crua: exigem posse, sempre. */
  readonly handles: readonly string[]
}

/**
 * Espelho que segue a posse EM TEMPO DE CHAMADA.
 *
 * Decidir na construcao era o defeito: o plane escolhia "persistencia inteira" porque havia
 * lease, e continuava com ela depois de `lease.release()` — enquanto outro processo, ja dono
 * legitimo, escrevia o mesmo banco. A fachada consultava `held` a cada chamada; a
 * persistencia publica, nao. Agora as duas perguntam a mesma coisa, na mesma hora.
 *
 * `Proxy` em vez de copia porque os stores sao classes com campo privado (`#handle`): um
 * objeto derivado por `Object.create` perderia o `this` e quebraria na primeira leitura.
 */
function comPosse<T extends object>(
  alvo: T,
  regras: RegrasDeAcesso,
  podeEscrever: () => boolean,
): T {
  const recusa = (acao: string): CommandRefusedError =>
    new CommandRefusedError(`control plane sem posse do projeto: ${acao} recusado (I14)`)
  return new Proxy(alvo, {
    get(target, prop, _receiver): unknown {
      if (typeof prop === 'string' && regras.handles.includes(prop)) {
        // Lancado, nao rejeitado: `database` e `db` sao propriedades, e devolver uma promessa
        // aqui seria devolver um objeto que o chamador usaria como se fosse a conexao.
        if (!podeEscrever()) throw recusa(`acesso a conexao por \`${prop}\``)
        return Reflect.get(target, prop, target)
      }
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      const leitura =
        regras.leituras === undefined ||
        (typeof prop === 'string' && regras.leituras.includes(prop))
      if (leitura || podeEscrever()) return value.bind(target)
      return (): Promise<never> => Promise.reject(recusa(String(prop)))
    },
  })
}

/**
 * A persistencia como o plane pode expo-la: escreve enquanto for dono, le sempre.
 *
 * Envolver TAMBEM o plane com posse e proposital — e o que faz a capacidade morrer junto com
 * o lease, em vez de sobreviver a ele.
 */
function persistenciaSobPosse(persistence: Persistence, podeEscrever: () => boolean): Persistence {
  const store = <T extends object>(alvo: T, leituras: readonly string[]): T =>
    comPosse(alvo, { leituras, handles: PORTAS_DA_CONEXAO }, podeEscrever)
  const espelho: Persistence = {
    ...persistence,
    runs: store(persistence.runs, LEITURAS_DA_PERSISTENCIA.runs),
    events: store(persistence.events, LEITURAS_DA_PERSISTENCIA.events),
    artifacts: store(persistence.artifacts, LEITURAS_DA_PERSISTENCIA.artifacts),
    // `queries` so tem SELECT; o que precisa de guarda ali e a conexao crua.
    queries: comPosse(persistence.queries, { handles: PORTAS_DA_CONEXAO }, podeEscrever),
  }
  return comPosse(espelho, { handles: PORTA_DA_PERSISTENCIA }, podeEscrever)
}

/** Perfis declarados no projeto; sem declaracao, um por papel suportado pelo provider. */
export function profilesOf(project: ProjectFile): AgentProfile[] {
  const profiles: AgentProfile[] = []
  for (const [id, config] of Object.entries(project.providers.registry)) {
    const providerId = toProviderId(id)
    const declared = Object.entries(config.profiles ?? {})
    if (declared.length > 0) {
      for (const [profileId, profile] of declared) {
        profiles.push({
          id: toAgentProfileId(profileId),
          role: profile.role,
          providerId,
          model: profile.model,
          systemContextRef: profile.systemContextRef,
          tags: [...profile.tags],
        })
      }
      continue
    }
    for (const role of config.roles as readonly AgentRole[]) {
      profiles.push({
        id: toAgentProfileId(`${id}.${role}`),
        role,
        providerId,
        tags: [],
      })
    }
  }
  return profiles
}

function envAllowlist(allow: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of allow) {
    const value = nodeProcess.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

interface RunWiring {
  readonly workspaces: AttemptWorkspaceProvider
  readonly missionWorkspaces?: MissionWorkspaceProvider
  readonly integrator: Integrator
}

/**
 * Composition root: monta banco, stores, registry de providers, workspace provider, gate
 * runner, integrador, scheduler, relogio e ids a partir do `project.yaml` ja validado.
 * E o que a CLI e o servidor usam — nenhum deles monta pecas por conta propria.
 */
export function createControlPlane(config: ControlPlaneConfig): ControlPlane {
  const repoRoot = resolve(config.repoRoot ?? config.project.project.repoRoot)
  const baseDir = config.baseDir ?? resolve(repoRoot, '.agentic')
  const lease = config.lease
  /**
   * O lease tem de proteger ESTE projeto, nao um qualquer.
   *
   * "Ter algum lease" nao e prova de posse: um lease legitimo de `/repo-A` autorizava um
   * plane aberto sobre `/repo-B`, e ai o control plane de B — que disputou a posse de B
   * corretamente — ganharia um segundo escritor sem nunca saber. A conferencia e por caminho
   * REAL, a mesma da posse, entao alias e link simbolico continuam sendo o mesmo projeto.
   */
  if (lease !== undefined && canonicalIfPresent(lease.ownedDir) !== canonicalIfPresent(baseDir)) {
    throw new CommandRefusedError(
      `posse de ${lease.ownedDir} nao autoriza operar ${baseDir}: um lease vale para o ` +
        'projeto que ele protege, e so para ele (I14)',
    )
  }
  const aberta = openPersistence({
    baseDir,
    ...(config.databasePath === undefined ? {} : { databasePath: config.databasePath }),
  })
  /**
   * A capacidade de escrever segue a posse EM TEMPO DE CHAMADA, e nao e escolhida aqui.
   *
   * Decidir na construcao deixava o plane com a persistencia inteira depois de
   * `lease.release()` — enquanto outro processo, ja dono legitimo, escrevia o mesmo banco.
   */
  // `=== true` de proposito: `lease?.held` devolveria `undefined` sem lease, e um
  // `undefined` circulando como "talvez" e a forma exata do defeito que esta fatia fechou.
  const podeEscrever = (): boolean => lease?.held === true
  const persistence = persistenciaSobPosse(aberta, podeEscrever)
  const clock = config.clock ?? systemClock()
  const ids = config.ids ?? ulidGenerator({ clock })
  const registry =
    config.registry ??
    createProviderRegistryFromProject(config.project, {
      ...(config.scripts === undefined ? {} : { scripts: config.scripts }),
      ...(config.providerFactories === undefined ? {} : { factories: config.providerFactories }),
    })
  const gates = loadGateProfiles(config.gatesFile)
  const gateRunner = config.gateRunner ?? new GateRunner()
  const profiles = profilesOf(config.project)
  const agentEnv = envAllowlist(config.agentEnvAllow ?? DEFAULT_AGENT_ENV_ALLOW)

  const deps: ApplicationDeps = {
    store: persistence.runs,
    artifacts: persistence.artifacts,
    events: persistence.events,
    registry,
    clock,
    ids,
  }

  /**
   * I14 na pratica: MUTAR exige posse DECLARADA e ainda VIVA.
   *
   * A guarda anterior so cobrava a posse quando ela existia (`lease !== undefined && !held`),
   * e por isso lia a ausencia como permissao. Era o segundo bypass medido em 003B: um plane
   * construido sem lease — `mission approve` pelo caminho local, uma composicao esquecida,
   * um harness — criava run, aprovava missao e iniciava run no `state.db` de um projeto que
   * pertence a OUTRO processo. Nao ha meio-termo aqui: sem prova de posse, recusa.
   *
   * Sao duas perguntas diferentes, e as duas precisam de resposta:
   *
   * 1. **Este plane e dono?** Sem `lease`, ele nunca disputou nada. Quem so le nao precisa
   *    disputar, e por isso o plane sem posse continua existindo — ele apenas nao muta.
   * 2. **Ainda e?** A posse pode ter sido solta (encerramento em curso, ordem de `close`
   *    trocada) enquanto uma rota ainda tenta agir. Depois de `release`, este plane nao
   *    manda mais neste projeto, mesmo que o processo continue vivo.
   */
  const exigirPosse = (acao: string): void => {
    if (lease === undefined) {
      throw new CommandRefusedError(
        `control plane aberto sem posse do projeto: ${acao} recusado (I14)`,
      )
    }
    if (!lease.held) {
      throw new CommandRefusedError(`control plane sem posse do projeto: ${acao} recusado (I14)`)
    }
  }

  /**
   * A mesma cobranca, em forma de promessa recusada.
   *
   * `createRun`, `approveMission` e `startRun` sao declarados `Promise`, e um `throw`
   * sincrono deles escapa por fora do `.catch()` de quem chama — o erro certo, no lugar
   * errado. Recusar assincronamente mantem o contrato do tipo.
   */
  const recusarSemPosse = <T>(acao: string): Promise<T> | undefined => {
    try {
      exigirPosse(acao)
      return undefined
    } catch (error) {
      return Promise.reject(error)
    }
  }

  const orchestrators = new Map<string, Orchestrator>()
  /** Aberturas em voo, por run: o que impede dois donos nascerem em paralelo (I13). */
  const opening = new Map<string, Promise<Orchestrator>>()
  let closed = false

  const wiringFor = (mission: MissionSpec): RunWiring => {
    const execution = config.project.execution
    if (execution.workspace === 'shared') {
      return {
        workspaces: new SharedWorkspaceProvider({
          root: repoRoot,
          repoRoot,
          // Fila silenciosa travaria o tick: com uma arvore so, o segundo lease e recusado.
          onBusy: 'fail',
          workspaceSetup: execution.workspaceSetup,
        }),
        // Sem worktree nao ha segunda arvore: o gate da missao roda na unica que existe.
        missionWorkspaces: {
          acquireMission: (request) =>
            Promise.resolve({
              id: `shared/${request.attemptId}`,
              kind: 'shared' as const,
              path: repoRoot,
              leasedBy: request.attemptId,
            }),
          release: () => Promise.resolve(),
        },
        integrator: new SharedTreeIntegrator(),
      }
    }
    const provider = new GitWorktreeWorkspaceProvider({
      repoRoot,
      missionId: mission.id,
      worktreeRoot: execution.worktreeRoot,
      missionBranchPrefix: config.project.integration.missionBranchPrefix,
      taskBranchPrefix: config.project.integration.taskBranchPrefix,
      workspaceSetup: execution.workspaceSetup,
    })
    return {
      workspaces: provider,
      missionWorkspaces: {
        acquireMission: (request) =>
          provider.acquireMissionWorkspace({
            runId: request.runId,
            attemptId: request.attemptId,
            missionId: request.missionId,
          }),
        release: (workspace, disposition) => provider.release(workspace, disposition),
      },
      integrator: new GitIntegrator({
        repoRoot,
        missionId: mission.id,
        worktreeRoot: execution.worktreeRoot,
        missionBranchPrefix: config.project.integration.missionBranchPrefix,
        taskBranchPrefix: config.project.integration.taskBranchPrefix,
      }),
    }
  }

  const build = async (runId: RunId): Promise<Orchestrator> => {
    const run = await loadRun(deps, runId)
    const mission = await loadMissionSpec(deps, runId)
    if (mission === undefined) {
      throw new CommandRefusedError(
        `run ${runId} sem MissionSpec persistida: nao ha o que executar`,
      )
    }
    const wiring = wiringFor(mission)
    if (wiring.workspaces instanceof GitWorktreeWorkspaceProvider) {
      await wiring.workspaces.ensureMissionBranch(mission.id)
    }
    const engineDeps: EngineDeps = {
      store: persistence.runs,
      artifacts: persistence.artifacts,
      workspaces: wiring.workspaces,
      missionWorkspaces: wiring.missionWorkspaces,
      integrator: wiring.integrator,
      gates,
      gateRunner,
      registry,
      events: persistence.events,
      clock,
      ids,
      mission,
      executorProfiles: profiles.filter((profile) => profile.role === 'executor'),
      reviewerProfiles: profiles.filter((profile) => profile.role === 'reviewer'),
      projectReviewPolicy: {
        byRisk: config.project.policies.review.byRisk,
        default: config.project.policies.review.default,
      },
      missionGateId: run.missionGateId,
      agentEnv,
      ...(config.agentLog === undefined ? {} : { agentLog: config.agentLog }),
      safetyIntervalMs: config.safetyIntervalMs,
    }
    return new Orchestrator(engineDeps, runId)
  }

  /**
   * UM orquestrador por run nesta instancia (I13), inclusive sob chamadas concorrentes.
   *
   * Guardar a INSTANCIA nao bastava: entre consultar o mapa e povoa-lo, `build` atravessa
   * varios `await` (banco, artefato, `ensureMissionBranch`), e duas chamadas simultaneas
   * — a adocao do boot e uma rota HTTP, por exemplo, ja que a API atende antes de a adocao
   * terminar — construiriam dois donos, com o segundo sobrescrevendo o primeiro no mapa e
   * o primeiro seguindo vivo e invisivel. Guardar a PROMESSA fecha a janela: a segunda
   * chamada espera a primeira em vez de comecar outra.
   */
  const open = (runId: RunId): Promise<Orchestrator> => {
    // Depois de `close` nao ha banco para abrir contra: recusar e melhor que devolver um
    // dono que so vai falhar no primeiro tick.
    if (closed) {
      return Promise.reject(new CommandRefusedError('control plane encerrado: nada a abrir'))
    }
    const semPosse = recusarSemPosse<Orchestrator>(`abrir orquestrador do run ${runId}`)
    if (semPosse !== undefined) return semPosse
    const existing = orchestrators.get(runId)
    if (existing !== undefined) return Promise.resolve(existing)
    const pending = opening.get(runId)
    if (pending !== undefined) return pending
    const promise = build(runId)
      .then((orchestrator) => {
        orchestrators.set(runId, orchestrator)
        return orchestrator
      })
      // Falha nao deixa a promessa presa no mapa: a proxima chamada tenta de novo.
      .finally(() => opening.delete(runId))
    opening.set(runId, promise)
    return promise
  }

  /**
   * I13: depois do boot, todo run em `RECOVERABLE_ACTIVE_RUN_STATUSES` tem UM orquestrador
   * vivo COM O LOOP LIGADO nesta instancia.
   *
   * `open` sozinho nao serve. Ele cria o dono, mas deixa `#autoTick` desligado: e por isso
   * que hoje um `resume` depois de um reinicio despacha trabalho num tick unico e nunca
   * colhe o resultado. Quem adota tem de ligar o loop — por isso `start()`.
   *
   * Adotar nao RETOMA trabalho de agente: o primeiro tick comeca por `#reconcile`, que
   * ENCERRA como `INTERRUPTED` o que ficou em voo em vez de continua-lo. O despacho so vem
   * depois, sobre estado limpo, como tentativa nova cobrada do orcamento (I4). O mission
   * gate e excecao declarada — sem marcador duravel de inicio, uma execucao interrompida e
   * refeita do zero. Isso e seguro porque o gate MEDE um commit em vez de mudar o
   * repositorio (ver STATE-MACHINES, I13).
   *
   * Um run recuperavel que nao abre (MissionSpec ausente, worktree ocupada) nao derruba o
   * boot nem os outros: vira recusa registrada. Entre PROCESSOS, quem garante que so existe
   * um adotante e a posse do projeto (I14): sem ela, esta funcao recusa.
   */
  const adoptRecoverableRuns = async (): Promise<AdoptionResult> => {
    // Somente o dono adota. Dois processos adotando o mesmo run foi o dano medido em D4:
    // duas worktrees no mesmo caminho e tentativas descartadas por transicao invalida.
    exigirPosse('adotar runs recuperaveis')
    const adopted: RunAdoption[] = []
    const refused: RunAdoptionRefusal[] = []
    const rows = persistence.queries.listRuns({ status: [...RECOVERABLE_ACTIVE_RUN_STATUSES] })
    for (const row of rows) {
      if (!isRunId(row.id) || !isRunStatus(row.status)) continue
      const runId = row.id
      // Lido ANTES de `open`, que e quem cria: depois da chamada todo run parece ja possuido.
      const alreadyOwned = orchestrators.has(runId) || opening.has(runId)
      try {
        const orchestrator = await open(runId)
        // A linha da consulta e um retrato; abrir leva varios `await` e a API ja atende.
        // Um `stop` no meio do caminho torna o run terminal, e ligar um loop para ele
        // seria manter um timer aceso sobre trabalho que ninguem mais quer.
        const atual = await deps.store.loadRun(runId)
        const status = atual?.status ?? row.status
        if (atual === undefined || !isRecoverableActiveRunStatus(status)) {
          refused.push({
            runId,
            status,
            reason: `run deixou de ser recuperavel durante a adocao (${status})`,
          })
          continue
        }
        orchestrator.start()
        adopted.push({ runId, status, alreadyOwned })
      } catch (error) {
        refused.push({
          runId,
          status: row.status,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { adopted, refused }
  }

  return {
    persistence,
    ...(lease === undefined ? {} : { instanceId: lease.instanceId }),
    registry,
    gates,
    clock,
    ids,
    deps,
    validateMission,
    compileMission,
    // Estas tres escrevem estado sem passar por `open`, entao cobram a guarda por conta
    // propria — e cobram a MESMA guarda: num plane sem posse declarada elas recusam, como
    // `open` e `adoptRecoverableRuns`. Foi por aqui que `mission approve` mutava o projeto
    // de outro processo (003B).
    createRun: (input) =>
      recusarSemPosse<Run>('criar run') ??
      createRun(deps, { ...input, project: input.project ?? config.project }),
    approveMission: (input) =>
      recusarSemPosse<Run>('aprovar missao') ?? approveMission(deps, input),
    startRun: (input) => recusarSemPosse<Run>('iniciar run') ?? startRun(deps, input),
    pauseRun: async (runId, command) => pauseRun(await open(runId), command),
    resumeRun: async (runId, command) => resumeRun(await open(runId), command),
    stopRun: async (runId, command) => stopRun(await open(runId), command),
    unblockTask: async (runId, command) => unblockTask(await open(runId), command),
    retryTask: async (runId, command) => retryTask(await open(runId), command),
    skipTask: async (runId, command) => skipTask(await open(runId), command),
    cancelTask: async (runId, command) => (await open(runId)).cancelTask(command),
    getRunSnapshot: (runId) => getRunSnapshot(deps, runId),
    getTaskDetail: (runId, taskId) => getTaskDetail(deps, runId, taskId),
    generateMissionReport: (runId) => generateMissionReport(deps, runId),
    open,
    adoptRecoverableRuns,
    close: async () => {
      // Fechar sem olhar para `opening` deixava a pior sobra possivel: uma abertura
      // iniciada antes do fechamento terminava depois, povoava o mapa ja limpo e entregava
      // ao chamador um dono vivo sobre um banco fechado. Barrar novas aberturas e esperar
      // as em voo custa um `await`; o oposto custa um orquestrador fantasma.
      closed = true
      const emVoo = await Promise.allSettled([...opening.values()])
      for (const aberto of emVoo) {
        if (aberto.status === 'fulfilled') await aberto.value.abandon().catch(() => undefined)
      }
      opening.clear()
      for (const orchestrator of orchestrators.values()) await orchestrator.abandon()
      orchestrators.clear()
      // A conexao REAL, nao o espelho: fechar e devolver recurso, nao escrever estado.
      aberta.close()
    },
  }
}

export type { CompiledGraph }
