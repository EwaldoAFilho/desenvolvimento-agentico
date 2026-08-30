import type {
  Attempt,
  AttemptId,
  DomainEvent,
  DomainEventInput,
  GateExecution,
  PathScope,
  Review,
  Run,
  RunId,
  TaskRun,
} from '@agentic/domain'
import type { SqliteDatabase } from './driver.js'
import {
  attemptToRow,
  eventToInsertRow,
  gateExecutionToRow,
  reviewToRow,
  rowToEvent,
  runToRow,
  taskRunToRow,
} from './mapping.js'
import { prepareCached, SQL } from './statements.js'

/**
 * Escritas sincronas de baixo nivel. Sao sincronas de proposito: a transacao do
 * better-sqlite3 e sincrona, e e ela que sustenta I1.
 */
export function writeRun(db: SqliteDatabase, run: Run): void {
  prepareCached(db, SQL.upsertRun).run(runToRow(run))
}

export function writeTaskRun(db: SqliteDatabase, taskRun: TaskRun): void {
  prepareCached(db, SQL.upsertTaskRun).run(taskRunToRow(taskRun))
}

export function writeAttempt(db: SqliteDatabase, attempt: Attempt): void {
  prepareCached(db, SQL.upsertAttempt).run(attemptToRow(attempt))
  for (const execution of attempt.gateExecutions) writeGateExecution(db, execution)
  if (attempt.review !== undefined) writeReview(db, attempt.review)
}

export function writeGateExecution(db: SqliteDatabase, execution: GateExecution): void {
  prepareCached(db, SQL.upsertGateExecution).run(gateExecutionToRow(execution))
}

export function writeReview(db: SqliteDatabase, review: Review): void {
  prepareCached(db, SQL.upsertReview).run(reviewToRow(review))
}

export function writeLock(
  db: SqliteDatabase,
  runId: RunId,
  pathPrefix: PathScope,
  attemptId: AttemptId,
  acquiredAt: Date,
): void {
  prepareCached(db, SQL.upsertLock).run({
    run_id: runId,
    path_prefix: pathPrefix,
    attempt_id: attemptId,
    acquired_at: acquiredAt.toISOString(),
  })
}

export function eraseLock(db: SqliteDatabase, runId: RunId, pathPrefix: PathScope): void {
  prepareCached(db, SQL.deleteLock).run(runId, pathPrefix)
}

/** `seq` e do banco (AUTOINCREMENT): quem emite o evento nao o conhece. */
export function writeEvent(db: SqliteDatabase, event: DomainEventInput): DomainEvent {
  const row = eventToInsertRow(event)
  const result = prepareCached(db, SQL.insertEvent).run(row)
  return rowToEvent({ ...row, seq: Number(result.lastInsertRowid) })
}
