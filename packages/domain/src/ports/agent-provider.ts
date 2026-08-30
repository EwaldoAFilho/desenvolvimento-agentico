import type { AgentClaims, Usage } from '../attempt.js'
import type { GateExecution } from '../gate.js'
import type { AttemptId, MissionId, ProviderId, RunId, TaskId } from '../ids.js'
import type { PathScope } from '../path-scope.js'
import type { ReviewPolicy } from '../review.js'
import type { Workspace } from './workspace.js'

export type AgentRunStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface AgentLogEvent {
  readonly ts: Date
  readonly stream: 'stdout' | 'stderr'
  readonly chunk: string
}

export type AgentOutcomeStatus = 'completed' | 'failed' | 'timeout' | 'cancelled'

/** `claims` e relato, nao fato: nao decide transicao nem basta para DONE (P05). */
export interface AgentOutcome {
  readonly status: AgentOutcomeStatus
  readonly claims: AgentClaims
  readonly usage?: Usage
  readonly logsRef: string
}

/** Contrato fechado: contexto minimo suficiente, sem dump do projeto inteiro (P14). */
export interface AssignmentBase {
  readonly missionId: MissionId
  readonly runId: RunId
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly objective: string
  readonly description?: string
  readonly constraints: readonly string[]
  readonly touches: readonly PathScope[]
  readonly reads: readonly PathScope[]
  readonly denyPaths: readonly string[]
  readonly satisfiedDependencies: readonly TaskId[]
  readonly validation: readonly string[]
  readonly workspacePath: string
  readonly timeoutMs: number
}

export interface ExecuteAssignment extends AssignmentBase {
  readonly kind: 'execute'
}

/** Revisao recebe evidencia — diff e resultado de gate — nunca a narrativa do executor (P07). */
export interface ReviewAssignment extends AssignmentBase {
  readonly kind: 'review'
  readonly diffRef: string
  readonly gateExecutions: readonly GateExecution[]
  readonly policy: ReviewPolicy
}

export type Assignment = ExecuteAssignment | ReviewAssignment

export interface DispatchContext {
  readonly runId: RunId
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly workspace: Workspace
  readonly timeoutMs: number
  /** Allowlist. Nenhuma credencial e injetada por nos (P17). */
  readonly env: Readonly<Record<string, string>>
}

export interface ProviderCapabilities {
  readonly roles: readonly ('executor' | 'reviewer')[]
  readonly streaming: boolean
  readonly cancellation: boolean
  readonly readinessProbe: 'supported' | 'unsupported'
  readonly reportsUsage: boolean
}

/**
 * `unknown` e valor de primeira classe: quando a CLI nao permite observar instalacao,
 * versao ou autenticacao de forma confiavel, reportamos `unknown` — nunca inferimos.
 */
export interface ProviderHealth {
  readonly providerId: ProviderId
  readonly installed: boolean | 'unknown'
  readonly ready: boolean | 'unknown'
  readonly version: string | 'unknown'
  readonly detail: string
  readonly probedAt: Date
  /** Contabilidade nossa: sempre conhecida. */
  readonly running: number
  readonly capacity: number | null
}

export interface AgentHandle {
  readonly ref: string
  status(): AgentRunStatus
  cancel(reason: string): Promise<void>
  result(): Promise<AgentOutcome>
  logs(): AsyncIterable<AgentLogEvent>
}

export interface AgentProvider {
  readonly id: ProviderId
  capabilities(): ProviderCapabilities
  start(assignment: Assignment, ctx: DispatchContext): Promise<AgentHandle>
}

/** Entrada pura do scheduler: o retrato chega pronto, o scheduler nao consulta nada. */
export interface CapacitySnapshot {
  readonly global: { readonly maxParallelTasks: number; readonly active: number }
  readonly executor: { readonly max: number; readonly active: number }
  readonly reviewer: { readonly max: number; readonly active: number }
  readonly byProvider: Readonly<
    Record<string, { readonly maxConcurrent: number; readonly running: number }>
  >
}

export interface ProviderRegistry {
  get(id: ProviderId): AgentProvider
  list(): ProviderId[]
  health(): Promise<ProviderHealth[]>
  capacity(): CapacitySnapshot
}
