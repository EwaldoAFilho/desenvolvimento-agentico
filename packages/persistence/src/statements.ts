import type { SqliteDatabase, SqliteStatement } from './driver.js'

const cache = new WeakMap<SqliteDatabase, Map<string, SqliteStatement>>()

/** Prepara uma vez por conexao: o mesmo SQL e reexecutado a cada transicao do run. */
export function prepareCached(db: SqliteDatabase, sql: string): SqliteStatement {
  let perDb = cache.get(db)
  if (perDb === undefined) {
    perDb = new Map<string, SqliteStatement>()
    cache.set(db, perDb)
  }
  const existing = perDb.get(sql)
  if (existing !== undefined) return existing
  const prepared = db.prepare(sql)
  perDb.set(sql, prepared)
  return prepared
}

export function upsertSql(
  table: string,
  columns: readonly string[],
  keys: readonly string[],
): string {
  const names = columns.join(', ')
  const placeholders = columns.map((column) => `@${column}`).join(', ')
  const updates = columns
    .filter((column) => !keys.includes(column))
    .map((column) => `${column} = excluded.${column}`)
    .join(', ')
  return (
    `INSERT INTO ${table} (${names}) VALUES (${placeholders}) ` +
    `ON CONFLICT(${keys.join(', ')}) DO UPDATE SET ${updates}`
  )
}

export function insertSql(table: string, columns: readonly string[]): string {
  const names = columns.join(', ')
  const placeholders = columns.map((column) => `@${column}`).join(', ')
  return `INSERT INTO ${table} (${names}) VALUES (${placeholders})`
}

export const RUN_COLUMNS = [
  'id',
  'mission_id',
  'spec_hash',
  'status',
  'policies_json',
  'graph_json',
  'created_at',
  'approved_at',
  'started_at',
  'finished_at',
  'integration_branch',
  'mission_gate_id',
  'mission_gate_execution_id',
  'failure_reason',
] as const

export const TASK_RUN_COLUMNS = [
  'run_id',
  'task_id',
  'status',
  'attempt_count',
  'current_attempt_id',
  'unblocked_by_json',
  'ready_at',
  'started_at',
  'finished_at',
  'outcome',
  'blockage_json',
] as const

export const ATTEMPT_COLUMNS = [
  'id',
  'run_id',
  'task_id',
  'attempt_number',
  'executor_json',
  'dispatch_reason_json',
  'workspace_json',
  'started_at',
  'finished_at',
  'duration_ms',
  'result',
  'failure_code',
  'failure_detail',
  'claims_json',
  'observation_json',
  'usage_json',
] as const

export const GATE_EXECUTION_COLUMNS = [
  'id',
  'run_id',
  'scope',
  'gate_id',
  'attempt_id',
  'status',
  'started_at',
  'finished_at',
  'results_json',
] as const

export const REVIEW_COLUMNS = [
  'id',
  'attempt_id',
  'reviewer_json',
  'verdict',
  'findings_json',
  'rationale',
  'duration_ms',
  'input_json',
  'policy',
  'policy_outcome',
  'policy_outcome_reason',
] as const

export const EVENT_COLUMNS = [
  'run_id',
  'ts',
  'type',
  'actor',
  'task_id',
  'attempt_id',
  'payload_json',
] as const

export const LOCK_COLUMNS = ['run_id', 'path_prefix', 'attempt_id', 'acquired_at'] as const

export const ARTIFACT_COLUMNS = [
  'id',
  'run_id',
  'kind',
  'path',
  'digest',
  'bytes',
  'created_at',
] as const

export const SQL = {
  upsertRun: upsertSql('runs', RUN_COLUMNS, ['id']),
  upsertTaskRun: upsertSql('task_runs', TASK_RUN_COLUMNS, ['run_id', 'task_id']),
  upsertAttempt: upsertSql('attempts', ATTEMPT_COLUMNS, ['id']),
  upsertGateExecution: upsertSql('gate_executions', GATE_EXECUTION_COLUMNS, ['id']),
  upsertReview: upsertSql('reviews', REVIEW_COLUMNS, ['id']),
  upsertLock: upsertSql('locks', LOCK_COLUMNS, ['run_id', 'path_prefix']),
  upsertArtifact: upsertSql('artifacts', ARTIFACT_COLUMNS, ['run_id', 'path']),
  insertEvent: insertSql('events', EVENT_COLUMNS),
  deleteLock: 'DELETE FROM locks WHERE run_id = ? AND path_prefix = ?',
} as const
