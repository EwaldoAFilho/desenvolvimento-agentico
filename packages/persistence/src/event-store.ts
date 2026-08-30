import type { DomainEvent, DomainEventInput, EventQuery, EventStore, RunId } from '@agentic/domain'
import type { DatabaseHandle } from './database.js'
import type { SqliteDatabase } from './driver.js'
import { ReadOnlyDatabaseError } from './errors.js'
import { rowToEvent } from './mapping.js'
import { ChangeNotifier } from './notifier.js'
import type { EventRow } from './rows.js'
import { prepareCached } from './statements.js'
import { writeEvent } from './writes.js'

export const DEFAULT_POLL_INTERVAL_MS = 100
export const DEFAULT_PAGE_SIZE = 500

export interface EventStoreOptions {
  readonly notifier?: ChangeNotifier
  /** Escrita de outro processo nao passa pelo notifier: o poll e a rede de seguranca. */
  readonly pollIntervalMs?: number
  readonly pageSize?: number
}

/** Append-only (P12): nao existe update nem delete sobre evento gravado. */
export class SqliteEventStore implements EventStore {
  readonly #handle: DatabaseHandle
  readonly #notifier: ChangeNotifier
  readonly #pollIntervalMs: number
  readonly #pageSize: number
  #closed = false

  constructor(handle: DatabaseHandle, options: EventStoreOptions = {}) {
    this.#handle = handle
    this.#notifier = options.notifier ?? new ChangeNotifier()
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.#pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  }

  get db(): SqliteDatabase {
    return this.#handle.db
  }

  get notifier(): ChangeNotifier {
    return this.#notifier
  }

  append(event: DomainEventInput): Promise<DomainEvent> {
    if (this.#handle.mode === 'readonly') throw new ReadOnlyDatabaseError('append')
    const written = writeEvent(this.db, event)
    this.#notifier.notify()
    return Promise.resolve(written)
  }

  list(runId: RunId, query: EventQuery = {}): Promise<DomainEvent[]> {
    return Promise.resolve(this.listSync(runId, query))
  }

  /**
   * `afterSeq` e exclusivo: o cliente do SSE reconecta com o ultimo `seq` que viu e recebe o
   * proximo em diante — sem perder e sem repetir.
   */
  listSync(runId: RunId, query: EventQuery = {}): DomainEvent[] {
    const afterSeq = query.afterSeq ?? 0
    const params: (string | number)[] = [runId, afterSeq]
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
    const rows = prepareCached(this.db, sql).all(...params) as EventRow[]
    return rows.map(rowToEvent)
  }

  latestSeq(runId?: RunId): number {
    const row = (
      runId === undefined
        ? prepareCached(this.db, 'SELECT MAX(seq) AS seq FROM events').get()
        : prepareCached(this.db, 'SELECT MAX(seq) AS seq FROM events WHERE run_id = ?').get(runId)
    ) as { seq: number | null }
    return row.seq ?? 0
  }

  count(runId?: RunId): number {
    const row = (
      runId === undefined
        ? prepareCached(this.db, 'SELECT COUNT(*) AS total FROM events').get()
        : prepareCached(this.db, 'SELECT COUNT(*) AS total FROM events WHERE run_id = ?').get(runId)
    ) as { total: number }
    return row.total
  }

  /** Stream do dashboard. Termina quando o store fecha; o consumidor pode sair a qualquer hora. */
  async *subscribe(runId: RunId, afterSeq: number): AsyncIterable<DomainEvent> {
    let cursor = afterSeq
    while (!this.#closed) {
      const batch = this.listSync(runId, { afterSeq: cursor, limit: this.#pageSize })
      if (batch.length > 0) {
        for (const event of batch) {
          cursor = event.seq
          yield event
        }
        continue
      }
      if (this.#notifier.closed) break
      await this.#notifier.wait(this.#pollIntervalMs)
    }
  }

  close(): void {
    this.#closed = true
    this.#notifier.close()
  }
}

export function createEventStore(
  handle: DatabaseHandle,
  options?: EventStoreOptions,
): SqliteEventStore {
  return new SqliteEventStore(handle, options)
}
