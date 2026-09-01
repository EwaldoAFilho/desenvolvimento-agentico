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
import { openPersistence, type Persistence } from '@agentic/persistence'
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
 * O que o control plane precisa saber da posse do projeto (I14): quem somos e se ainda
 * somos. Nada de adquirir ou soltar — isso e do processo que fez o boot. `ControlPlaneLease`
 * de `@agentic/persistence` satisfaz esta forma.
 */
export interface OwnershipLease {
  readonly instanceId: string
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
   * Posse do projeto. Presente = este plane so age enquanto for o dono (I14). Ausente =
   * plane sem posse: serve para ler e para teste, e NAO deve abrir orquestrador em producao.
   * Quem sobe control plane de verdade (`startServer`, `mission start`) sempre passa uma.
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
  const persistence = openPersistence({
    baseDir: config.baseDir ?? resolve(repoRoot, '.agentic'),
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

  const deps: ApplicationDeps = {
    store: persistence.runs,
    artifacts: persistence.artifacts,
    events: persistence.events,
    registry,
    clock,
    ids,
  }

  const lease = config.lease

  /**
   * I14 na pratica: um plane que declarou posse nao age depois de perde-la.
   *
   * O perdedor da disputa nem chega aqui — `startServer` recusa antes de abrir banco. Esta
   * guarda cobre o outro caso, mais silencioso: a posse foi solta (encerramento em curso,
   * ordem de `close` trocada) e alguma rota ainda tenta abrir um dono. Agir sem posse e
   * exatamente o defeito que D4 descreve, entao aqui ele vira recusa com motivo.
   */
  const exigirPosse = (acao: string): void => {
    if (lease !== undefined && !lease.held) {
      throw new CommandRefusedError(`control plane sem posse do projeto: ${acao} recusado (I14)`)
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
    try {
      exigirPosse(`abrir orquestrador do run ${runId}`)
    } catch (error) {
      return Promise.reject(error)
    }
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
    createRun: (input) => createRun(deps, { ...input, project: input.project ?? config.project }),
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
      persistence.close()
    },
  }
}

export type { CompiledGraph }
