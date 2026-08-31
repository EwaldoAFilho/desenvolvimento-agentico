import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import nodeProcess from 'node:process'
import type { CompiledGraph } from '@agentic/compiler'
import {
  type AgentProfile,
  type AgentRole,
  type Clock,
  type IdGenerator,
  type Integrator,
  isMissionId,
  type MissionId,
  type MissionPlanner,
  type MissionPlannerRegistry,
  type MissionSpec,
  type ProviderRegistry,
  type Run,
  type RunId,
  type TaskId,
  agentProfileId as toAgentProfileId,
  missionId as toMissionId,
  providerId as toProviderId,
} from '@agentic/domain'
import { type GateProfiles, GateRunner, loadGateProfiles } from '@agentic/gates'
import { openPersistence, type Persistence } from '@agentic/persistence'
import {
  BUILT_IN_PLANNER_DESCRIPTORS,
  createMissionPlannerRegistry,
  createProviderRegistryFromProject,
  LocalCliMissionPlanner,
  type MockScript,
  type ProviderFactory,
} from '@agentic/providers'
import type { GatesFile, ProjectFile, RunSnapshot, TaskDetail } from '@agentic/schemas'
import { parseMissionFile } from '@agentic/schemas'
import {
  GitIntegrator,
  GitWorktreeWorkspaceProvider,
  git,
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
  DEFAULT_PLANNING_TIMEOUT_MS,
  generateMissionReport,
  getRunSnapshot,
  getTaskDetail,
  loadMissionSpec,
  loadRun,
  type MissionArtifactStore,
  MissionFileExistsError,
  type MissionReport,
  type PlanMissionInput,
  type PlanMissionResult,
  type PlanningDeps,
  type ProjectSourceText,
  pauseRun,
  planMission,
  type RepoObserver,
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

/** Onde as missoes do projeto moram, dentro do `baseDir`. */
const DEFAULT_MISSIONS_DIR = 'missions'

const MISSION_FILE_SUFFIX = '.mission.yaml'
const MISSION_FILE_SUFFIXES = ['.yaml', '.yml']

export interface ControlPlaneConfig {
  readonly project: ProjectFile
  readonly gatesFile: GatesFile
  /**
   * Conteudo BRUTO do project.yaml e do gates.yaml. Compilar e funcao pura sobre texto
   * (ARCHITECTURE 7), e planejar compila a proposta antes de gravar qualquer coisa. Ausentes,
   * o control plane le os dois do disco na primeira vez que precisar.
   */
  readonly projectText?: string
  readonly gatesText?: string
  /** Raiz do repositorio alvo. Default: `project.project.repoRoot`. */
  readonly repoRoot?: string
  readonly baseDir?: string
  /** Onde o artefato da missao e gravado. Default: `<baseDir>/missions`. */
  readonly missionsDir?: string
  /** Planejadores disponiveis. Ausente: os derivados das CLIs declaradas no projeto. */
  readonly planners?: MissionPlannerRegistry
  readonly planningTimeoutMs?: number
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
}

export interface ControlPlane {
  readonly persistence: Persistence
  readonly registry: ProviderRegistry
  /**
   * Quem sabe propor missao. Lista vazia e resposta legitima: nem todo projeto declara uma
   * CLI que saiba planejar.
   *
   * Opcional no CONTRATO, e nunca em `createControlPlane`: existe implementacao parcial de
   * `ControlPlane` fora deste pacote, e exigir planejamento de quem so precisa despachar
   * task quebraria essas implementacoes sem ganho. Quem consome recusa explicitamente
   * quando falta, em vez de assumir que existe.
   */
  readonly planners?: MissionPlannerRegistry
  readonly gates: GateProfiles
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly deps: ApplicationDeps
  validateMission(input: CompileInput): ReturnType<typeof validateMission>
  compileMission(input: CompileInput): CompileResult
  createRun(input: Omit<CreateRunInput, 'project'> & { project?: ProjectFile }): Promise<Run>
  /** Ver `planners`: opcional pelo mesmo motivo, e sempre presente em `createControlPlane`. */
  planMission?(input: PlanMissionInput): Promise<PlanMissionResult>
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
  close(): Promise<void>
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

// --------------------------------------------------------------------------------------
// Planejamento: quem pode propor, onde o artefato mora, como o repositorio e observado
// --------------------------------------------------------------------------------------

/**
 * Planejadores derivados das CLIs que o projeto declara. So entra a CLI para a qual
 * conhecemos um modo nao interativo de LEITURA: pedir plano a uma CLI cujo modo de leitura
 * desconhecemos seria adivinhar permissao de escrita, e planejar nao escreve.
 *
 * Provider in-process nao vira planejador — simulador nao se apresenta como planejamento de
 * verdade (ADR-0013 4). Planejador simulado entra por `config.planners`, nomeado como tal.
 */
function plannersOf(project: ProjectFile): MissionPlannerRegistry {
  const planners: MissionPlanner[] = []
  for (const [id, config] of Object.entries(project.providers.registry)) {
    if (config.kind !== 'local-cli') continue
    const descriptor = BUILT_IN_PLANNER_DESCRIPTORS[id]
    if (descriptor === undefined) continue
    planners.push(
      new LocalCliMissionPlanner(descriptor, {
        id: toProviderId(id),
        ...(config.command === undefined ? {} : { command: config.command }),
        ...(config.versionArgs === undefined ? {} : { versionArgs: config.versionArgs }),
      }),
    )
  }
  const preferred = project.providers.default
  const isPlanner = planners.some((planner) => String(planner.id) === preferred)
  return createMissionPlannerRegistry({
    planners,
    ...(isPlanner ? { default: toProviderId(preferred) } : {}),
  })
}

/** Id da missao pelo NOME do arquivo. `DA-UX-001.mission.yaml` -> `DA-UX-001`. */
function missionIdOfFile(name: string): MissionId | undefined {
  const suffix = MISSION_FILE_SUFFIXES.find((item) => name.endsWith(item))
  if (suffix === undefined) return undefined
  const base = name.slice(0, -suffix.length)
  const id = base.endsWith('.mission') ? base.slice(0, -'.mission'.length) : base
  return isMissionId(id) ? id : undefined
}

function posix(path: string): string {
  return path.split(sep).join('/')
}

/**
 * O artefato da missao em disco. `create` usa `wx`: se o arquivo ja existe, o sistema de
 * arquivos recusa — nao ha janela entre conferir e gravar em que outro pedido pudesse
 * sobrescrever o plano de alguem.
 */
function missionArtifactStore(repoRoot: string, missionsDir: string): MissionArtifactStore {
  const fileOf = (id: MissionId): string => join(missionsDir, `${id}${MISSION_FILE_SUFFIX}`)
  return {
    pathFor: (id) => posix(relative(repoRoot, fileOf(id))),
    /**
     * Nome do arquivo E id declarado dentro dele: um plano gravado com outro nome continua
     * ocupando o id, e propor esse id daria colisao so na hora de compilar.
     */
    taken: async (): Promise<readonly MissionId[]> => {
      let entries: string[]
      try {
        entries = await readdir(missionsDir)
      } catch {
        // Diretorio ausente e projeto sem missao — o estado normal de quem acabou de comecar.
        return []
      }
      const taken = new Set<string>()
      for (const name of entries) {
        const fromName = missionIdOfFile(name)
        if (fromName !== undefined) taken.add(fromName)
        if (!MISSION_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue
        const text = await readFile(join(missionsDir, name), 'utf8').catch(() => undefined)
        if (text === undefined) continue
        const parsed = parseMissionFile(text)
        if (parsed.ok) taken.add(parsed.value.id)
      }
      return [...taken].sort().map((id) => toMissionId(id))
    },
    create: async (id, text): Promise<void> => {
      const path = fileOf(id)
      await mkdir(dirname(path), { recursive: true })
      try {
        await writeFile(path, text, { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (code === 'EEXIST') throw new MissionFileExistsError(posix(relative(repoRoot, path)))
        throw error
      }
    },
  }
}

/**
 * O que o control plane consegue MEDIR do repositorio sem alterar nada: o commit atual e o
 * que o git ve de diferente dele. Duas leituras iguais em volta da chamada do planejador sao
 * a evidencia de que planejar nao alterou arquivo.
 *
 * LIMITE CONHECIDO, registrado em vez de escondido: `git diff HEAD` compara conteudo DEPOIS
 * dos filtros do git. Com `.gitattributes` declarando `text`, trocar LF por CRLF (ou o
 * contrario) nao aparece em lugar nenhum — para o git aquilo nao e mudanca. Uma alteracao
 * so de fim de linha em arquivo normalizado passa despercebida aqui.
 *
 * Nao e defeito desta funcao: e o significado de "mudou" que o proprio git define. Fechar
 * exigiria hashear bytes do disco de todo arquivo rastreado a cada leitura, em toda chamada
 * de planejamento, e o custo nao paga o cenario. Fica dito, e vale lembrar o modelo do
 * produto: verificado, nao confinado. Esta digital detecta alteracao comum; ela nao e
 * barreira contra processo adversarial — quem consegue rodar `git update-index` tambem
 * consegue commitar.
 *
 * Somente conteudo versionado — arquivo ignorado fica de fora de proposito: `.agentic/` e o
 * banco do proprio control plane mudam durante o planejamento, e cobra-los aqui trocaria a
 * garantia por um alarme permanente. Sem git nao ha observacao, e ausencia de observacao nao
 * vale como prova: o caso de uso recusa em vez de afirmar o que nao mediu.
 */
export function gitRepoObserver(repoRoot: string): RepoObserver {
  return {
    fingerprint: async (): Promise<string | undefined> => {
      try {
        const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
          cwd: repoRoot,
          stage: 'diff',
        })
        // Repositorio sem nenhum commit nao tem HEAD, e isso nao impede a comparacao.
        const head = await git(['rev-parse', 'HEAD'], {
          cwd: repoRoot,
          allowFailure: true,
          stage: 'diff',
        })
        // `status` diz NOME e ESTADO, nunca conteudo: um arquivo que ja estava modificado
        // continua saindo como ` M caminho` depois de ser reescrito, e um nao rastreado
        // continua saindo como `?? caminho`. So com isso, o planejador poderia sobrescrever
        // qualquer um dos dois sem mover a impressao digital — e a garantia de "nada mudou
        // alem do artefato da missao" seria vazia justamente onde ha trabalho em andamento.
        //
        // O conteudo entra por dois caminhos que NAO alteram o indice: o patch do que ja e
        // rastreado, e o hash do que ainda nao e. `--intent-to-add` resolveria os dois de
        // uma vez, mas escreve no indice, e observar nao pode alterar o que observa.
        // `assume-unchanged` e `skip-worktree` mandam o git IGNORAR alteracao no arquivo:
        // com o bit ligado, status e diff HEAD ficam vazios mesmo com o conteudo mudado.
        //
        // Nao basta incluir os bits na digital. Se o bit ja estiver ligado ANTES da primeira
        // leitura, as duas digitais nascem iguais e a alteracao no meio fica invisivel do
        // mesmo jeito. Com o bit ligado o git simplesmente NAO consegue reportar mudanca
        // naquele arquivo — entao nao ha observacao a ser feita, e a resposta honesta e
        // recusar, como em todo o resto deste observador.
        //
        // `ls-files -v` marca assume-unchanged com letra MINUSCULA e skip-worktree com `S`.
        const flags = await git(['ls-files', '-v'], {
          cwd: repoRoot,
          allowFailure: true,
          stage: 'diff',
        })
        if (flags.exitCode !== 0) return undefined
        const ocultos = flags.stdout
          .split('\n')
          .filter((linha) => linha.length > 1)
          .some((linha) => {
            const marca = linha[0] ?? ''
            return marca === 'S' || (marca >= 'a' && marca <= 'z')
          })
        if (ocultos) return undefined
        const patch = await git(['diff', 'HEAD', '--no-ext-diff', '--no-color'], {
          cwd: repoRoot,
          allowFailure: true,
          stage: 'diff',
        })
        const untracked = status.stdout
          .split('\0')
          .filter((entry) => entry.startsWith('?? '))
          .map((entry) => entry.slice(3))
          .filter((path) => path.length > 0)
          .sort()
        // A lista de caminhos vai por STDIN, nao por argv: argv tem teto de tamanho no
        // sistema operacional (32.767 caracteres no Windows) e nenhum lote finito resolve um
        // caminho unico grande demais. `--stdin-paths` tira o problema da equacao.
        //
        // `--stdin-paths` nao aceita qualquer byte: separa por quebra de linha, LE linha
        // iniciada por aspas como C-quoted, e descarta `\r` no fim. Um nome com qualquer
        // dessas formas seria lido como OUTRO caminho — e o git responderia exit 0, com a
        // contagem certa, hasheando o arquivo errado. Alteracao invisivel com aparencia de
        // observacao completa e pior que recusa, entao esses nomes recusam: e a mesma
        // doutrina do resto deste observador — ausencia de observacao nao vale prova.
        // U+FFFD num caminho significa uma de duas coisas, e nenhuma permite prosseguir: ou
        // o nome no disco tem bytes que nao sao UTF-8 e o wrapper do git os destruiu na
        // decodificacao, ou o arquivo se chama assim mesmo. No primeiro caso a string nao
        // aponta mais para o arquivo certo — e pode apontar para OUTRO, rastreado ou nao,
        // fazendo `hash-object` sair 0 sobre o arquivo errado e escondendo a alteracao.
        // Distinguir os dois casos exigiria o helper git devolver bytes em vez de string,
        // o que atinge toda chamada git do produto e e mudanca de outra missao. Aqui a
        // resposta honesta e recusar a observacao inteira.
        const irrepresentavel = (caminho: string): boolean =>
          caminho.includes('\n') ||
          caminho.includes('\r') ||
          caminho.startsWith('"') ||
          caminho.includes('\uFFFD')
        let contents = ''
        if (untracked.length > 0) {
          if (untracked.some(irrepresentavel)) return undefined
          // O wrapper do git decodifica em UTF-8, entao um nome POSIX com bytes invalidos
          // vira U+FFFD. Se existir tambem um arquivo chamado literalmente com esse
          // caractere, os dois viram a MESMA string: `--stdin-paths` hashearia o segundo
          // duas vezes, com exit 0 e contagem certa, e alteracao no primeiro ficaria
          // invisivel. Nome repetido depois da decodificacao e prova de que a lista nao
          // representa mais o disco — entao recusa.
          if (new Set(untracked).size !== untracked.length) return undefined
          const hashes = await git(['hash-object', '--stdin-paths'], {
            cwd: repoRoot,
            allowFailure: true,
            stage: 'diff',
            stdin: `${untracked.join('\n')}\n`,
          })
          const saida = hashes.stdout.split('\n').filter((linha) => linha.length > 0)
          // Hash que faltou nao pode virar `?`: devolveria impressao digital DEFINIDA sem ter
          // observado o conteudo, e uma reescrita ficaria invisivel — exatamente o defeito
          // que esta funcao existe para fechar.
          if (hashes.exitCode !== 0 || saida.length !== untracked.length) return undefined
          contents = untracked.map((caminho, i) => `${caminho} ${saida[i]}`).join('\n')
        }
        return [head.stdout.trim(), status.stdout, flags.stdout, patch.stdout, contents].join(
          '\n---\n',
        )
      } catch {
        return undefined
      }
    },
  }
}

/**
 * Composition root: monta banco, stores, registry de providers, workspace provider, gate
 * runner, integrador, scheduler, relogio e ids a partir do `project.yaml` ja validado.
 * E o que a CLI e o servidor usam — nenhum deles monta pecas por conta propria.
 */
export function createControlPlane(config: ControlPlaneConfig): ControlPlane {
  const repoRoot = resolve(config.repoRoot ?? config.project.project.repoRoot)
  const baseDir = config.baseDir ?? resolve(repoRoot, '.agentic')
  const persistence = openPersistence({
    baseDir,
    ...(config.databasePath === undefined ? {} : { databasePath: config.databasePath }),
  })
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
  const planners = config.planners ?? plannersOf(config.project)
  const missionsDir = resolve(repoRoot, config.missionsDir ?? join(baseDir, DEFAULT_MISSIONS_DIR))

  /**
   * O TEXTO dos dois arquivos, nao o objeto ja validado: compilar a proposta e funcao pura
   * sobre conteudo. Quando o chamador nao os entrega, sao lidos do disco uma vez e guardados
   * — reler a cada correcao faria o projeto mudar no meio do ciclo de reparo.
   */
  let sources: ProjectSourceText | undefined =
    config.projectText === undefined || config.gatesText === undefined
      ? undefined
      : { projectText: config.projectText, gatesText: config.gatesText }

  const loadSources = async (): Promise<ProjectSourceText> => {
    if (sources !== undefined) return sources
    const gatesPath = isAbsolute(config.project.gates.file)
      ? config.project.gates.file
      : resolve(repoRoot, config.project.gates.file)
    const projectPath = join(baseDir, 'project.yaml')
    try {
      const [projectText, gatesText] = await Promise.all([
        readFile(projectPath, 'utf8'),
        readFile(gatesPath, 'utf8'),
      ])
      sources = { projectText, gatesText }
      return sources
    } catch (error) {
      throw new CommandRefusedError(
        `nao foi possivel ler a configuracao do projeto para compilar a proposta: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const planningDeps: PlanningDeps = {
    planners,
    missions: missionArtifactStore(repoRoot, missionsDir),
    repo: gitRepoObserver(repoRoot),
    sources: loadSources,
    project: config.project,
    gates: gates.ids,
    readRoot: repoRoot,
    timeoutMs: config.planningTimeoutMs ?? DEFAULT_PLANNING_TIMEOUT_MS,
  }

  const deps: ApplicationDeps = {
    store: persistence.runs,
    artifacts: persistence.artifacts,
    events: persistence.events,
    registry,
    clock,
    ids,
  }

  const orchestrators = new Map<string, Orchestrator>()

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

  const open = async (runId: RunId): Promise<Orchestrator> => {
    const existing = orchestrators.get(runId)
    if (existing !== undefined) return existing
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
    const orchestrator = new Orchestrator(engineDeps, runId)
    orchestrators.set(runId, orchestrator)
    return orchestrator
  }

  return {
    persistence,
    registry,
    planners,
    gates,
    clock,
    ids,
    deps,
    validateMission,
    compileMission,
    createRun: (input) => createRun(deps, { ...input, project: input.project ?? config.project }),
    planMission: (input) => planMission(deps, planningDeps, input),
    approveMission: (input) => approveMission(deps, input),
    startRun: (input) => startRun(deps, input),
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
    close: async () => {
      for (const orchestrator of orchestrators.values()) await orchestrator.abandon()
      orchestrators.clear()
      persistence.close()
    },
  }
}

export type { CompiledGraph }
