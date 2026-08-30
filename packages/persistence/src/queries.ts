import type { RunId, TaskId } from '@agentic/domain'
import type { DatabaseHandle } from './database.js'
import type { SqliteDatabase } from './driver.js'
import type {
  ArtifactRow,
  AttemptRow,
  EventRow,
  GateExecutionRow,
  LockRow,
  ReviewRow,
  RunListRow,
  RunRow,
  TaskRunRow,
  TaskStatusCountRow,
} from './rows.js'
import { prepareCached } from './statements.js'

export interface RunSnapshotData {
  readonly run: RunRow | undefined
  readonly taskRuns: readonly TaskRunRow[]
  /** Apenas as tentativas correntes: o cabecalho nao carrega historico. */
  readonly currentAttempts: readonly AttemptRow[]
  readonly statusCounts: readonly TaskStatusCountRow[]
  readonly latestSeq: number
}

export interface TaskDetailData {
  readonly taskRun: TaskRunRow | undefined
  readonly attempts: readonly AttemptRow[]
  readonly gateExecutions: readonly GateExecutionRow[]
  readonly reviews: readonly ReviewRow[]
  readonly locks: readonly LockRow[]
  readonly artifacts: readonly ArtifactRow[]
}

export interface ReadEventsQuery {
  readonly runId: RunId
  /** Exclusivo. `sinceSeq: 0` (ou ausente) devolve desde o inicio. */
  readonly sinceSeq?: number
  readonly limit?: number
  readonly types?: readonly string[]
}

export interface ListRunsQuery {
  readonly status?: readonly string[]
  readonly limit?: number
}

/**
 * Consultas do dashboard. Devolvem linha crua: a montagem do DTO e do server, que e a camada
 * que conhece o pacote de contratos. Este pacote nao o importa.
 */
export class SqliteQueries {
  readonly #handle: DatabaseHandle

  constructor(handle: DatabaseHandle) {
    this.#handle = handle
  }

  get db(): SqliteDatabase {
    return this.#handle.db
  }

  getRunSnapshotData(runId: RunId): RunSnapshotData {
    const run = prepareCached(this.db, 'SELECT * FROM runs WHERE id = ?').get(runId) as
      | RunRow
      | undefined
    const taskRuns = prepareCached(
      this.db,
      'SELECT * FROM task_runs WHERE run_id = ? ORDER BY task_id',
    ).all(runId) as TaskRunRow[]
    const currentAttempts = prepareCached(
      this.db,
      `SELECT a.* FROM attempts a
         JOIN task_runs t ON t.current_attempt_id = a.id AND t.run_id = a.run_id
        WHERE a.run_id = ?
        ORDER BY a.task_id`,
    ).all(runId) as AttemptRow[]
    const statusCounts = prepareCached(
      this.db,
      'SELECT status, COUNT(*) AS total FROM task_runs WHERE run_id = ? GROUP BY status ORDER BY status',
    ).all(runId) as TaskStatusCountRow[]
    const seq = prepareCached(this.db, 'SELECT MAX(seq) AS seq FROM events WHERE run_id = ?').get(
      runId,
    ) as { seq: number | null }

    return { run, taskRuns, currentAttempts, statusCounts, latestSeq: seq.seq ?? 0 }
  }

  listRuns(query: ListRunsQuery = {}): RunListRow[] {
    const params: (string | number)[] = []
    let where = ''
    if (query.status !== undefined && query.status.length > 0) {
      where = ` WHERE r.status IN (${query.status.map(() => '?').join(', ')})`
      params.push(...query.status)
    }
    let sql = `SELECT r.id, r.mission_id, r.status, r.created_at, r.started_at, r.finished_at,
        (SELECT COUNT(*) FROM task_runs t WHERE t.run_id = r.id) AS task_total,
        (SELECT COUNT(*) FROM task_runs t WHERE t.run_id = r.id AND t.status = 'DONE') AS task_done
      FROM runs r${where}
      ORDER BY r.created_at DESC, r.id DESC`
    if (query.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(Math.max(0, Math.trunc(query.limit)))
    }
    return prepareCached(this.db, sql).all(...params) as RunListRow[]
  }

  getTaskDetailData(runId: RunId, taskId: TaskId): TaskDetailData {
    const taskRun = prepareCached(
      this.db,
      'SELECT * FROM task_runs WHERE run_id = ? AND task_id = ?',
    ).get(runId, taskId) as TaskRunRow | undefined
    const attempts = prepareCached(
      this.db,
      'SELECT * FROM attempts WHERE run_id = ? AND task_id = ? ORDER BY attempt_number',
    ).all(runId, taskId) as AttemptRow[]
    const gateExecutions = prepareCached(
      this.db,
      `SELECT g.* FROM gate_executions g
         JOIN attempts a ON a.id = g.attempt_id
        WHERE a.run_id = ? AND a.task_id = ?
        ORDER BY g.started_at, g.id`,
    ).all(runId, taskId) as GateExecutionRow[]
    const reviews = prepareCached(
      this.db,
      `SELECT rv.* FROM reviews rv
         JOIN attempts a ON a.id = rv.attempt_id
        WHERE a.run_id = ? AND a.task_id = ?
        ORDER BY a.attempt_number, rv.id`,
    ).all(runId, taskId) as ReviewRow[]
    const locks = prepareCached(
      this.db,
      `SELECT l.* FROM locks l
         JOIN attempts a ON a.id = l.attempt_id
        WHERE l.run_id = ? AND a.task_id = ?
        ORDER BY l.path_prefix`,
    ).all(runId, taskId) as LockRow[]
    const artifacts = prepareCached(
      this.db,
      'SELECT * FROM artifacts WHERE run_id = ? ORDER BY path',
    ).all(runId) as ArtifactRow[]

    return { taskRun, attempts, gateExecutions, reviews, locks, artifacts }
  }

  /** Base do SSE: `sinceSeq` exclusivo, ordenado por `seq`, sem buraco e sem repeticao. */
  readEvents(query: ReadEventsQuery): EventRow[] {
    const params: (string | number)[] = [query.runId, query.sinceSeq ?? 0]
    let sql = 'SELECT * FROM events WHERE run_id = ? AND seq > ?'
    if (query.types !== undefined && query.types.length > 0) {
      sql += ` AND type IN (${query.types.map(() => '?').join(', ')})`
      params.push(...query.types)
    }
    sql += ' ORDER BY seq'
    if (query.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(Math.max(0, Math.trunc(query.limit)))
    }
    return prepareCached(this.db, sql).all(...params) as EventRow[]
  }

  listArtifacts(runId: RunId): ArtifactRow[] {
    return prepareCached(this.db, 'SELECT * FROM artifacts WHERE run_id = ? ORDER BY path').all(
      runId,
    ) as ArtifactRow[]
  }
}

export function createQueries(handle: DatabaseHandle): SqliteQueries {
  return new SqliteQueries(handle)
}
