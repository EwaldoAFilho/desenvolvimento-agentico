import { join, resolve } from 'node:path'
import {
  type ArtifactStoreDeps,
  createArtifactStore,
  type FileArtifactStore,
} from './artifact-store.js'
import { type DatabaseHandle, type DatabaseMode, openDatabase } from './database.js'
import { createEventStore, type SqliteEventStore } from './event-store.js'
import { ChangeNotifier } from './notifier.js'
import { createQueries, type SqliteQueries } from './queries.js'
import { createRunStore, type SqliteRunStore } from './run-store.js'

export const DEFAULT_BASE_DIR = '.agentic'
export const DEFAULT_DATABASE_FILE = 'state.db'

export interface OpenPersistenceOptions {
  /** Diretorio de estado do projeto; por padrao `.agentic` (ADR-0003). */
  readonly baseDir?: string
  /**
   * NAO existe opcao de caminho do banco.
   *
   * `databasePath` existiu como conveniencia e virou um escape de posse: o lock protegia
   * `<baseDir>/control-plane.lock.db` enquanto o `state.db` mutavel podia ser apontado para
   * QUALQUER lugar — inclusive o diretorio de um projeto que pertence a outro processo. Duas
   * identidades para um projeto so e a forma exata do defeito que I14 existe para impedir.
   *
   * A regra agora e uma linha: UM PROJETO -> UM runtimeDir -> UM lock -> UM `state.db`. Quem
   * precisa de outro banco usa outro `baseDir`, e ai leva o lock junto.
   */
  readonly mode?: DatabaseMode
  readonly busyTimeoutMs?: number
  readonly pollIntervalMs?: number
  /** Primitivos de arquivo do store de artefatos; so o teste os troca. */
  readonly artifacts?: ArtifactStoreDeps
}

export interface Persistence {
  readonly database: DatabaseHandle
  /** `readonly` = esta conexao nao escreve, e quem recusa e o SQLite. */
  readonly mode: DatabaseMode
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
  const mode = options.mode ?? 'readwrite'
  const database = openDatabase({
    // Derivado, nunca recebido: o banco mora ao lado do lock que o protege.
    path: join(baseDir, DEFAULT_DATABASE_FILE),
    mode,
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
    artifacts: createArtifactStore(database, baseDir, options.artifacts),
    queries: createQueries(database),
    baseDir,
    mode,
    close: (): void => {
      events.close()
      database.close()
    },
  }
}
