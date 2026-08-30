import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { type SqliteDatabase, sqliteDriver } from './driver.js'
import { SchemaVersionError } from './errors.js'
import { applyMigrations, LATEST_SCHEMA_VERSION, schemaVersion } from './migrations.js'

export type DatabaseMode = 'readwrite' | 'readonly'

export interface OpenDatabaseOptions {
  readonly path: string
  readonly mode?: DatabaseMode
  /** Espera antes de devolver SQLITE_BUSY. WAL + escritor unico raramente chega perto. */
  readonly busyTimeoutMs?: number
  /** `false` abre a conexao sem aplicar migracao pendente (usado em teste de versao). */
  readonly migrate?: boolean
}

export interface DatabaseHandle {
  readonly db: SqliteDatabase
  readonly path: string
  readonly mode: DatabaseMode
  readonly schemaVersion: number
  close(): void
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000

/**
 * I7 na pratica: `readwrite` e a conexao do orquestrador (WAL, escritor unico); `readonly`
 * e o que dashboard e CLI usam para ler sem nunca disputar a escrita.
 */
export function openDatabase(options: OpenDatabaseOptions): DatabaseHandle {
  const mode: DatabaseMode = options.mode ?? 'readwrite'
  const path = resolve(options.path)
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS

  // Unica escrita em disco fora do ArtifactStore: o diretorio do proprio arquivo do banco.
  if (mode === 'readwrite') mkdirSync(dirname(path), { recursive: true })

  const Driver = sqliteDriver()
  const db = new Driver(path, {
    readonly: mode === 'readonly',
    fileMustExist: mode === 'readonly',
    timeout: busyTimeoutMs,
  })

  db.pragma(`busy_timeout = ${busyTimeoutMs}`)
  db.pragma('foreign_keys = ON')

  if (mode === 'readwrite') {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    if (options.migrate !== false) applyMigrations(db)
  }

  const version = schemaVersionOf(db, mode)
  if (mode === 'readonly' && version !== LATEST_SCHEMA_VERSION) {
    db.close()
    throw new SchemaVersionError(version, LATEST_SCHEMA_VERSION)
  }

  return {
    db,
    path,
    mode,
    schemaVersion: version,
    close: (): void => {
      if (db.open) db.close()
    },
  }
}

function schemaVersionOf(db: SqliteDatabase, mode: DatabaseMode): number {
  if (mode === 'readwrite') return schemaVersion(db)
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get()
  if (row === undefined) return 0
  const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null
  }
  return version.version ?? 0
}

/** `PRAGMA journal_mode` como string, para diagnostico e teste. */
export function journalMode(db: SqliteDatabase): string {
  const rows = db.pragma('journal_mode') as { journal_mode: string }[]
  return rows[0]?.journal_mode ?? 'unknown'
}

export function busyTimeout(db: SqliteDatabase): number {
  const rows = db.pragma('busy_timeout') as { timeout: number }[]
  return rows[0]?.timeout ?? 0
}
