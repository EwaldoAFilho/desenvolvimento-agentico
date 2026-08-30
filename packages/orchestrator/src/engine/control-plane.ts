import { resolve } from 'node:path'
import nodeProcess from 'node:process'
import type { CompiledGraph } from '@agentic/compiler'
import {
  type AgentProfile,
  type AgentRole,
  type Clock,
  type IdGenerator,
  type Integrator,
  type MissionSpec,
  type ProviderRegistry,
  type Run,
  type RunId,
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
  readonly safetyIntervalMs?: number
}

export interface ControlPlane {
  readonly persistence: Persistence
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
      safetyIntervalMs: config.safetyIntervalMs,
    }
    const orchestrator = new Orchestrator(engineDeps, runId)
    orchestrators.set(runId, orchestrator)
    return orchestrator
  }

  return {
    persistence,
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
    close: async () => {
      for (const orchestrator of orchestrators.values()) await orchestrator.abandon()
      orchestrators.clear()
      persistence.close()
    },
  }
}

export type { CompiledGraph }
