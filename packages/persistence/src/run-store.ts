import type {
  Attempt,
  AttemptId,
  DomainEvent,
  GateExecution,
  Review,
  Run,
  RunId,
  RunQuery,
  RunStore,
  RunSummary,
  TaskId,
  TaskRun,
  TaskSpec,
} from '@agentic/domain'
import type { DatabaseHandle } from './database.js'
import type { SqliteDatabase } from './driver.js'
import { ReadOnlyDatabaseError } from './errors.js'
import { rowToAttempt, rowToGateExecution, rowToReview, rowToRun, rowToTaskRun } from './mapping.js'
import type { ChangeNotifier } from './notifier.js'
import type {
  AttemptRow,
  GateExecutionRow,
  LockRow,
  ReviewRow,
  RunRow,
  TaskRunRow,
} from './rows.js'
import { prepareCached } from './statements.js'
import {
  BufferedUnitOfWork,
  type RecoveryUnitOfWork,
  type TransactionalUnitOfWork,
} from './unit-of-work.js'

export interface CommitResult<T> {
  readonly result: T
  /** Eventos gravados nesta transacao, ja com o `seq` atribuido pelo banco. */
  readonly events: readonly DomainEvent[]
}

export interface RunStoreOptions {
  readonly notifier?: ChangeNotifier
}

/** I7: esta e a porta de escrita do orquestrador. Nenhum agente a recebe. */
export class SqliteRunStore implements RunStore {
  readonly #handle: DatabaseHandle
  readonly #notifier: ChangeNotifier | undefined

  constructor(handle: DatabaseHandle, options: RunStoreOptions = {}) {
    this.#handle = handle
    this.#notifier = options.notifier
  }

  get db(): SqliteDatabase {
    return this.#handle.db
  }

  /**
   * Criacao do run emite `run.created` e um `task.created` por task na mesma transacao: nao
   * existe momento em que o estado inicial esta gravado sem o evento que o explica (I1).
   */
  async createRun(run: Run, taskRuns: readonly TaskRun[]): Promise<void> {
    const dependencies = dependencyMap(run.graph.tasks, run.graph.edges)
    await this.withTransaction(async (uow) => {
      await uow.saveRun(run)
      await uow.appendEvent({
        runId: run.id,
        ts: run.createdAt,
        type: 'run.created',
        actor: { kind: 'orchestrator' },
        payload: { missionId: run.missionId, specHash: run.specHash },
      })
      for (const taskRun of taskRuns) {
        await uow.saveTaskRun(taskRun)
        await uow.appendEvent({
          runId: run.id,
          ts: run.createdAt,
          type: 'task.created',
          actor: { kind: 'orchestrator' },
          taskId: taskRun.taskId,
          payload: { dependencies: dependencies.get(taskRun.taskId) ?? [] },
        })
      }
    })
  }

  loadRun(id: RunId): Promise<Run | undefined> {
    const row = prepareCached(this.db, 'SELECT * FROM runs WHERE id = ?').get(id) as
      | RunRow
      | undefined
    return Promise.resolve(row === undefined ? undefined : rowToRun(row))
  }

  listRuns(query: RunQuery = {}): Promise<RunSummary[]> {
    const clauses: string[] = []
    const params: string[] = []
    if (query.missionId !== undefined) {
      clauses.push('mission_id = ?')
      params.push(query.missionId)
    }
    if (query.status !== undefined && query.status.length > 0) {
      clauses.push(`status IN (${query.status.map(() => '?').join(', ')})`)
      params.push(...query.status)
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const limit = query.limit === undefined ? '' : ` LIMIT ${Math.max(0, Math.trunc(query.limit))}`
    const rows = prepareCached(
      this.db,
      `SELECT id, mission_id, status, created_at, finished_at FROM runs${where} ORDER BY created_at DESC, id DESC${limit}`,
    ).all(...params) as Pick<
      RunRow,
      'id' | 'mission_id' | 'status' | 'created_at' | 'finished_at'
    >[]
    return Promise.resolve(
      rows.map((row) => {
        const summary: RunSummary = {
          id: row.id as RunId,
          missionId: row.mission_id as RunSummary['missionId'],
          status: row.status as RunSummary['status'],
          createdAt: new Date(row.created_at),
          ...(row.finished_at === null ? {} : { finishedAt: new Date(row.finished_at) }),
        }
        return summary
      }),
    )
  }

  loadTaskRuns(id: RunId): Promise<TaskRun[]> {
    const rows = prepareCached(
      this.db,
      'SELECT * FROM task_runs WHERE run_id = ? ORDER BY task_id',
    ).all(id) as TaskRunRow[]
    return Promise.resolve(rows.map(rowToTaskRun))
  }

  loadAttempts(id: RunId, taskId?: TaskId): Promise<Attempt[]> {
    const rows = (
      taskId === undefined
        ? prepareCached(
            this.db,
            'SELECT * FROM attempts WHERE run_id = ? ORDER BY task_id, attempt_number',
          ).all(id)
        : prepareCached(
            this.db,
            'SELECT * FROM attempts WHERE run_id = ? AND task_id = ? ORDER BY attempt_number',
          ).all(id, taskId)
    ) as AttemptRow[]
    return Promise.resolve(rows.map((row) => this.#hydrateAttempt(row)))
  }

  loadAttempt(attemptId: AttemptId): Promise<Attempt | undefined> {
    const row = prepareCached(this.db, 'SELECT * FROM attempts WHERE id = ?').get(attemptId) as
      | AttemptRow
      | undefined
    return Promise.resolve(row === undefined ? undefined : this.#hydrateAttempt(row))
  }

  listLocks(id: RunId): Promise<LockRow[]> {
    const rows = prepareCached(
      this.db,
      'SELECT * FROM locks WHERE run_id = ? ORDER BY path_prefix',
    ).all(id) as LockRow[]
    return Promise.resolve(rows)
  }

  /** I1. Ou grava estado e evento juntos, ou nao grava nada. */
  async withTransaction<T>(work: (uow: TransactionalUnitOfWork) => Promise<T>): Promise<T> {
    const commit = await this.commit(work)
    return commit.result
  }

  /** Mesma garantia de `withTransaction`, devolvendo tambem os eventos ja com `seq`. */
  async commit<T>(work: (uow: TransactionalUnitOfWork) => Promise<T>): Promise<CommitResult<T>> {
    return this.#execute(work)
  }

  /**
   * Caminho de migracao/recovery: o `work` recebe `putStateWithoutEvent(motivo)` e so entao
   * o commit aceita estado sem evento. Uso fora desses dois casos e bug.
   */
  async withRecoveryTransaction<T>(
    work: (uow: RecoveryUnitOfWork) => Promise<T>,
  ): Promise<CommitResult<T>> {
    return this.#execute(work)
  }

  async #execute<T>(work: (uow: BufferedUnitOfWork) => Promise<T>): Promise<CommitResult<T>> {
    // `writable`, nao `mode`: depois que a posse fecha a conexao, recusar aqui devolve um
    // erro do produto em vez do `TypeError` cru do driver — e recusa ANTES de rodar o
    // `work`, que pode ter efeitos proprios.
    if (!this.#handle.writable) throw new ReadOnlyDatabaseError('withTransaction')
    const uow = new BufferedUnitOfWork()
    const result = await work(uow)
    const pending = uow.drain()
    uow.assertInvariantI1(pending)
    if (pending.length === 0) return { result, events: [] }

    const emitted: DomainEvent[] = []
    const db = this.db
    db.transaction(() => {
      for (const write of pending) write.apply(db, emitted)
    }).immediate()

    if (emitted.length > 0) this.#notifier?.notify()
    return { result, events: emitted }
  }

  #hydrateAttempt(row: AttemptRow): Attempt {
    const gateRows = prepareCached(
      this.db,
      'SELECT * FROM gate_executions WHERE attempt_id = ? ORDER BY started_at, id',
    ).all(row.id) as GateExecutionRow[]
    const reviewRow = prepareCached(
      this.db,
      'SELECT * FROM reviews WHERE attempt_id = ? ORDER BY id LIMIT 1',
    ).get(row.id) as ReviewRow | undefined
    const gateExecutions: GateExecution[] = gateRows.map(rowToGateExecution)
    const review: Review | undefined = reviewRow === undefined ? undefined : rowToReview(reviewRow)
    return rowToAttempt(row, gateExecutions, review)
  }
}

function dependencyMap(
  tasks: readonly TaskSpec[],
  edges: readonly { readonly from: TaskId; readonly to: TaskId }[],
): Map<TaskId, TaskId[]> {
  const map = new Map<TaskId, TaskId[]>()
  for (const task of tasks) map.set(task.id, [...task.dependencies])
  for (const edge of edges) {
    const current = map.get(edge.to)
    if (current === undefined) map.set(edge.to, [edge.from])
    else if (!current.includes(edge.from)) current.push(edge.from)
  }
  return map
}

export function createRunStore(handle: DatabaseHandle, options?: RunStoreOptions): SqliteRunStore {
  return new SqliteRunStore(handle, options)
}
