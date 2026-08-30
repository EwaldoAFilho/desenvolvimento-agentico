import { createRequire } from 'node:module'

/**
 * `better-sqlite3` nao publica tipos e o repositorio nao pode ganhar dependencia nova nesta
 * task. Declaramos aqui apenas a superficie que usamos e carregamos o addon nativo via
 * `createRequire` — evita interop CJS/ESM divergente entre os dois tsconfig do repo.
 */
export type SqliteValue = string | number | bigint | Uint8Array | null

/** Parametros nomeados (`@coluna`); o driver aceita um objeto por chamada. */
export type SqliteBindings = Record<string, SqliteValue>

export type SqliteParam = SqliteValue | SqliteBindings

export interface SqliteRunResult {
  readonly changes: number
  readonly lastInsertRowid: number | bigint
}

export interface SqliteStatement {
  run(...params: SqliteParam[]): SqliteRunResult
  get(...params: SqliteParam[]): unknown
  all(...params: SqliteParam[]): unknown[]
  pluck(toggle?: boolean): SqliteStatement
}

export interface SqliteTransactionRunner<TResult> {
  (): TResult
  immediate(): TResult
  exclusive(): TResult
  deferred(): TResult
}

export interface SqliteDatabase {
  readonly name: string
  readonly open: boolean
  readonly readonly: boolean
  readonly inTransaction: boolean
  prepare(sql: string): SqliteStatement
  exec(sql: string): unknown
  pragma(sql: string, options?: { simple?: boolean }): unknown
  transaction<TResult>(fn: () => TResult): SqliteTransactionRunner<TResult>
  close(): unknown
}

export interface SqliteDriverOptions {
  readonly readonly?: boolean
  readonly fileMustExist?: boolean
  readonly timeout?: number
}

export type SqliteDriver = new (path: string, options?: SqliteDriverOptions) => SqliteDatabase

const load = createRequire(import.meta.url)

let cached: SqliteDriver | undefined

export function sqliteDriver(): SqliteDriver {
  if (cached === undefined) cached = load('better-sqlite3') as SqliteDriver
  return cached
}
