import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { type SqliteDatabase, sqliteDriver } from './driver.js'
import { DatabaseNotInitializedError, SchemaVersionError } from './errors.js'
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
  /**
   * Esta conexao pode escrever AGORA. Pergunta VIVA, nao decidida na construcao.
   *
   * `mode` sozinho responde a pergunta errada: ele diz como a conexao foi ABERTA, e nunca
   * muda quando ela fecha. Quem confia so nele acha que pode escrever num handle ja fechado
   * — e um caminho de escrita que produz efeito ANTES de tocar o banco (o artefato grava o
   * arquivo e so entao insere a linha) chega a mutar o disco antes de descobrir o engano.
   *
   * `db.open` fecha essa distancia: depois de `lease.release()` a conexao do dono e fechada,
   * e todo caminho de escrita passa a recusar no PRIMEIRO passo, sem efeito colateral.
   */
  readonly writable: boolean
  readonly schemaVersion: number
  close(): void
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000

/**
 * I7 e I14 na pratica, e o modo NAO e cosmetico: e a fronteira.
 *
 * `readwrite` e a conexao do DONO do projeto — WAL, escritor unico, migracoes aplicadas.
 * `readonly` e uma conexao que o proprio SQLite recusa escrever: `INSERT`, `UPDATE`,
 * `DELETE`, `CREATE TABLE` e transacao de escrita falham no DRIVER, nao num espelho de
 * JavaScript. E por isso que a capacidade nao pode ser recuperada por reflexao, descriptor
 * ou funcao capturada: nao ha nada escondido para reencontrar — a conexao simplesmente nao
 * sabe escrever.
 *
 * Em `readonly` o arquivo tambem precisa JA existir: criar `state.db` e rodar migracao sao
 * escritas, e escrita pertence a quem possui o projeto. Um `status` num projeto novo tem de
 * dizer "nao inicializado", nao inicializar.
 */
export function openDatabase(options: OpenDatabaseOptions): DatabaseHandle {
  const mode: DatabaseMode = options.mode ?? 'readwrite'
  const path = resolve(options.path)
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS

  // Unica escrita em disco fora do ArtifactStore: o diretorio do proprio arquivo do banco.
  if (mode === 'readwrite') mkdirSync(dirname(path), { recursive: true })
  // `fileMustExist` do driver ja recusaria, mas com `SQLITE_CANTOPEN` cru. Perguntar antes
  // troca um erro de biblioteca por um fato do produto — e e o fato que a CLI sabe explicar.
  if (mode === 'readonly' && !existsSync(path)) throw new DatabaseNotInitializedError(path)

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
    get writable(): boolean {
      return mode === 'readwrite' && db.open
    },
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
