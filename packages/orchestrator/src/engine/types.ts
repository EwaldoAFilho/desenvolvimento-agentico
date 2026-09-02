import type {
  AgentProfile,
  Attempt,
  AttemptId,
  Clock,
  DomainEvent,
  GateExecution,
  GateId,
  IdGenerator,
  Integrator,
  MissionId,
  MissionSpec,
  Observation,
  ProviderRegistry,
  Run,
  RunId,
  TaskId,
  TaskRun,
  Workspace,
  WorkspaceDisposition,
} from '@agentic/domain'
import type { GateProfiles, GateRunRequest, GateRunResult } from '@agentic/gates'
import type {
  ArtifactRecord,
  ArtifactWrite,
  LockRow,
  TransactionalUnitOfWork,
} from '@agentic/persistence'
import type { AttemptCommit, AttemptLease } from '@agentic/workspace'
import type { ProjectReviewPolicy } from '../scheduler/index.js'
import type { AgentLogConfig } from './agent-log.js'

/**
 * Recorte do `RunStore` que o orquestrador usa. Declarado aqui porque a transacao precisa
 * da unidade de trabalho com locks (I2), que a porta do dominio nao carrega.
 */
export interface OrchestratorStore {
  loadRun(id: RunId): Promise<Run | undefined>
  loadTaskRuns(id: RunId): Promise<TaskRun[]>
  loadAttempts(id: RunId, taskId?: TaskId): Promise<Attempt[]>
  listLocks(id: RunId): Promise<LockRow[]>
  /** A execucao do MISSION gate pelo id persistido no run: e a segunda metade de I12. */
  loadGateExecution(id: string): Promise<GateExecution | undefined>
  withTransaction<T>(work: (uow: TransactionalUnitOfWork) => Promise<T>): Promise<T>
}

export interface ArtifactWriter {
  write(input: ArtifactWrite): Promise<ArtifactRecord>
}

/**
 * `WorkspaceProvider` do dominio com o que os adapters de git realmente devolvem: o patch
 * junto da observacao e o `changed` do commit. Sem isso, NO_CHANGES nao seria observavel.
 */
export interface AttemptWorkspaceProvider {
  acquire(lease: AttemptLease): Promise<Workspace>
  diff(ws: Workspace): Promise<Observation & { readonly patch?: string }>
  commit(ws: Workspace, message: string): Promise<AttemptCommit>
  release(ws: Workspace, disposition: WorkspaceDisposition): Promise<void>
}

export interface MissionWorkspaceRequest {
  readonly runId: RunId
  readonly attemptId: AttemptId
  readonly missionId: MissionId
  /** Cancelamento cooperativo do `workspaceSetup` no encerramento do control plane. */
  readonly signal?: AbortSignal
}

/** O mission gate roda em worktree propria da branch da missao, nunca na ultima tentativa. */
export interface MissionWorkspaceProvider {
  acquireMission(request: MissionWorkspaceRequest): Promise<Workspace>
  release(ws: Workspace, disposition: WorkspaceDisposition): Promise<void>
}

/** Leitura do log: reconstroi as autorizacoes humanas de tentativa extra apos um restart. */
export interface EventReader {
  list(runId: RunId, query?: { readonly types?: readonly string[] }): Promise<DomainEvent[]>
}

export interface GateExecutor {
  run(request: GateRunRequest): Promise<GateRunResult>
}

export interface EngineDeps {
  readonly store: OrchestratorStore
  readonly artifacts: ArtifactWriter
  readonly workspaces: AttemptWorkspaceProvider
  readonly missionWorkspaces?: MissionWorkspaceProvider
  readonly integrator: Integrator
  readonly gates: GateProfiles
  readonly gateRunner: GateExecutor
  readonly registry: ProviderRegistry
  readonly events?: EventReader
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly mission: MissionSpec
  readonly executorProfiles: readonly AgentProfile[]
  readonly reviewerProfiles: readonly AgentProfile[]
  readonly projectReviewPolicy?: ProjectReviewPolicy
  readonly missionGateId?: GateId
  /** Allowlist repassada ao processo do agente. Nenhuma credencial e injetada (P17). */
  readonly agentEnv?: Readonly<Record<string, string>>
  /** Teto, redacao e espera do log do agente persistido por tentativa (ARCHITECTURE 6.1). */
  readonly agentLog?: AgentLogConfig
  /** Timer de seguranca do tick. `0` desliga (o teste dirige o loop). */
  readonly safetyIntervalMs?: number
}
