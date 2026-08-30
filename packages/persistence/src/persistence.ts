import { join, resolve } from 'node:path'
import { createArtifactStore, type FileArtifactStore } from './artifact-store.js'
import { type DatabaseHandle, type DatabaseMode, openDatabase } from './database.js'
import { createEventStore, type SqliteEventStore } from './event-store.js'
import { ChangeNotifier } from './notifier.js'
import { createQueries, type SqliteQueries } from './queries.js'
import { createRunStore, type SqliteRunStore } from './run-store.js'

export const DEFAULT_BASE_DIR = '.agentic'
export const DEFAULT_DATABASE_FILE = 'state.db'

export interface OpenPersistenceOptions {
  /** Diretorio base; por padrao `.agentic` (ADR-0003). */
  readonly baseDir?: string
  readonly databasePath?: string
  readonly mode?: DatabaseMode
  readonly busyTimeoutMs?: number
  readonly pollIntervalMs?: number
}

export interface Persistence {
  readonly database: DatabaseHandle
  readonly runs: SqliteRunStore
  readonly events: SqliteEventStore
  readonly artifacts: FileArtifactStore
  readonly queries: SqliteQueries
  readonly baseDir: string
  close(): void
}

/**
 * Monta o conjunto em volta de UMA conexao: o notifier compartilhado faz o `subscribe` do
 * dashboard acordar no commit, sem esperar o poll.
 */
export function openPersistence(options: OpenPersistenceOptions = {}): Persistence {
  const baseDir = resolve(options.baseDir ?? DEFAULT_BASE_DIR)
  const databasePath = options.databasePath ?? join(baseDir, DEFAULT_DATABASE_FILE)
  const database = openDatabase({
    path: databasePath,
    mode: options.mode ?? 'readwrite',
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
  })
  const notifier = new ChangeNotifier()
  const events = createEventStore(database, {
    notifier,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  })

  return {
    database,
    runs: createRunStore(database, { notifier }),
    events,
    artifacts: createArtifactStore(database, baseDir),
    queries: createQueries(database),
    baseDir,
    close: (): void => {
      events.close()
      database.close()
    },
  }
}
