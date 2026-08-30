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
  UnitOfWork,
} from '@agentic/domain'
import type { SqliteDatabase } from './driver.js'
import { StateWithoutEventError } from './errors.js'
import {
  eraseLock,
  writeAttempt,
  writeEvent,
  writeGateExecution,
  writeLock,
  writeReview,
  writeRun,
  writeTaskRun,
} from './writes.js'

/** Locks logicos por prefixo de caminho (ARCHITECTURE 5): sustentam I2 no scheduler. */
export interface LockWriter {
  acquireLock(
    runId: RunId,
    pathPrefix: PathScope,
    attemptId: AttemptId,
    acquiredAt?: Date,
  ): Promise<void>
  releaseLock(runId: RunId, pathPrefix: PathScope): Promise<void>
}

/** A porta `UnitOfWork` mais o que o scheduler precisa gravar na mesma transacao. */
export interface TransactionalUnitOfWork extends UnitOfWork, LockWriter {}

/**
 * Escotilha explicita para migracao e recovery — os dois unicos casos em que existe estado
 * legitimo sem evento correspondente. Fora deles, `withTransaction` recusa o commit (I1).
 */
export interface RecoveryUnitOfWork extends TransactionalUnitOfWork {
  putStateWithoutEvent(justification: string): void
}

type PendingKind = 'state' | 'event'

interface PendingWrite {
  readonly kind: PendingKind
  readonly label: string
  apply(db: SqliteDatabase, emitted: DomainEvent[]): void
}

/**
 * A transacao do better-sqlite3 e sincrona e a porta e assincrona: a unidade de trabalho
 * enfileira as escritas e o `withTransaction` as aplica dentro de UMA transacao. Consequencia
 * direta: se `work` lancar, a fila e descartada e nada — nem estado, nem evento — foi tocado.
 */
export class BufferedUnitOfWork implements RecoveryUnitOfWork {
  #pending: PendingWrite[] = []
  #justification: string | undefined

  get justification(): string | undefined {
    return this.#justification
  }

  get pendingCount(): number {
    return this.#pending.length
  }

  putStateWithoutEvent(justification: string): void {
    if (justification.trim().length === 0) {
      throw new StateWithoutEventError(['justificativa vazia'])
    }
    this.#justification = justification
  }

  saveRun(run: Run): Promise<void> {
    return this.#enqueue('state', `run:${run.id}`, (db) => {
      writeRun(db, run)
    })
  }

  saveTaskRun(taskRun: TaskRun): Promise<void> {
    return this.#enqueue('state', `task_run:${taskRun.taskId}`, (db) => {
      writeTaskRun(db, taskRun)
    })
  }

  saveAttempt(attempt: Attempt): Promise<void> {
    return this.#enqueue('state', `attempt:${attempt.id}`, (db) => {
      writeAttempt(db, attempt)
    })
  }

  saveGateExecution(execution: GateExecution): Promise<void> {
    return this.#enqueue('state', `gate_execution:${execution.id}`, (db) => {
      writeGateExecution(db, execution)
    })
  }

  saveReview(review: Review): Promise<void> {
    return this.#enqueue('state', `review:${review.id}`, (db) => {
      writeReview(db, review)
    })
  }

  acquireLock(
    runId: RunId,
    pathPrefix: PathScope,
    attemptId: AttemptId,
    acquiredAt: Date = new Date(),
  ): Promise<void> {
    return this.#enqueue('state', `lock:${pathPrefix}`, (db) => {
      writeLock(db, runId, pathPrefix, attemptId, acquiredAt)
    })
  }

  releaseLock(runId: RunId, pathPrefix: PathScope): Promise<void> {
    return this.#enqueue('state', `lock:${pathPrefix}`, (db) => {
      eraseLock(db, runId, pathPrefix)
    })
  }

  appendEvent(event: DomainEventInput): Promise<void> {
    return this.#enqueue('event', `event:${event.type}`, (db, emitted) => {
      emitted.push(writeEvent(db, event))
    })
  }

  /** Devolve a fila e zera a unidade: uma unidade de trabalho nao commita duas vezes. */
  drain(): PendingWrite[] {
    const pending = this.#pending
    this.#pending = []
    return pending
  }

  /** I1: estado sem evento so passa com a escotilha marcada. */
  assertInvariantI1(pending: readonly PendingWrite[]): void {
    if (this.#justification !== undefined) return
    const stateWrites = pending.filter((write) => write.kind === 'state')
    if (stateWrites.length === 0) return
    if (pending.some((write) => write.kind === 'event')) return
    throw new StateWithoutEventError(stateWrites.map((write) => write.label))
  }

  #enqueue(
    kind: PendingKind,
    label: string,
    apply: (db: SqliteDatabase, emitted: DomainEvent[]) => void,
  ): Promise<void> {
    this.#pending.push({ kind, label, apply })
    return Promise.resolve()
  }
}
