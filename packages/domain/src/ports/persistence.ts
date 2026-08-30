import type { Attempt } from '../attempt.js'
import type { DomainEvent, DomainEventInput } from '../events.js'
import type { GateExecution } from '../gate.js'
import type { MissionId, RunId, TaskId } from '../ids.js'
import type { Review } from '../review.js'
import type { Run, RunStatus } from '../run.js'
import type { TaskRun } from '../task-run.js'

export interface RunSummary {
  readonly id: RunId
  readonly missionId: MissionId
  readonly status: RunStatus
  readonly createdAt: Date
  readonly finishedAt?: Date
}

export interface RunQuery {
  readonly missionId?: MissionId
  readonly status?: readonly RunStatus[]
  readonly limit?: number
}

/**
 * Unidade de trabalho unica: e o que garante I1 — estado e evento na mesma transacao.
 * Nada aqui grava sozinho; o commit e do `withTransaction`.
 */
export interface UnitOfWork {
  saveRun(run: Run): Promise<void>
  saveTaskRun(taskRun: TaskRun): Promise<void>
  saveAttempt(attempt: Attempt): Promise<void>
  saveGateExecution(execution: GateExecution): Promise<void>
  saveReview(review: Review): Promise<void>
  appendEvent(event: DomainEventInput): Promise<void>
}

/** I7: o orquestrador e o unico escritor. Nenhum agente recebe esta porta. */
export interface RunStore {
  createRun(run: Run, taskRuns: readonly TaskRun[]): Promise<void>
  loadRun(id: RunId): Promise<Run | undefined>
  listRuns(query?: RunQuery): Promise<RunSummary[]>
  loadTaskRuns(id: RunId): Promise<TaskRun[]>
  loadAttempts(id: RunId, taskId?: TaskId): Promise<Attempt[]>
  withTransaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>
}

export interface EventQuery {
  readonly afterSeq?: number
  readonly limit?: number
  readonly types?: readonly string[]
}

/** Append-only (P12). Nao existe update sobre evento gravado. */
export interface EventStore {
  append(event: DomainEventInput): Promise<DomainEvent>
  list(runId: RunId, query?: EventQuery): Promise<DomainEvent[]>
  subscribe(runId: RunId, afterSeq: number): AsyncIterable<DomainEvent>
}
