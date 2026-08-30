import type { AgentIdentity } from './agent.js'
import type { Observation } from './evidence.js'
import type { FailureReason } from './failure-codes.js'
import type { GateExecution } from './gate.js'
import type { AttemptId, ProviderId, TaskId, TaskRunId } from './ids.js'
import type { PathScope } from './path-scope.js'
import type { Review } from './review.js'
import type { WorkspaceRef } from './workspace.js'

export const ATTEMPT_RESULTS = ['PASS', 'FAIL', 'ERROR', 'TIMEOUT', 'CANCELLED'] as const
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number]

/**
 * Relato do agente. O nome carrega a semantica: e informacao operacional, nunca fato, e
 * nao participa de nenhuma transicao de estado (P05).
 */
export interface AgentClaims {
  readonly summary: string
  readonly detail?: string
  readonly reportedFiles?: readonly string[]
}

export interface Usage {
  readonly model?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly costUsd?: number
}

/** Responde "por que esta executando agora?" sem depender de log (DOMAIN-MODEL 5). */
export interface DispatchReason {
  readonly dependenciesSatisfied: readonly TaskId[]
  readonly locksAcquired: readonly PathScope[]
  readonly providerId: ProviderId
  readonly slot: 'executor' | 'reviewer'
  readonly priority: number
  readonly note?: string
}

/** Append-only. Tentativa encerrada nunca e alterada (I5 / P12). */
export interface Attempt {
  readonly id: AttemptId
  readonly taskRunId: TaskRunId
  readonly attemptNumber: number
  readonly executor: AgentIdentity
  readonly dispatchReason: DispatchReason
  readonly workspace: WorkspaceRef
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly durationMs?: number
  readonly claims?: AgentClaims
  readonly observation?: Observation
  readonly gateExecutions: readonly GateExecution[]
  readonly review?: Review
  readonly result?: AttemptResult
  readonly failureReason?: FailureReason
  readonly usage?: Usage
}

export function isAttemptClosed(attempt: Attempt): boolean {
  return attempt.finishedAt !== undefined
}
