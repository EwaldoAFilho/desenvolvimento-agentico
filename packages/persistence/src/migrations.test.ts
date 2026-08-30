import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './__fixtures__/builders.js'
import { openDatabase } from './database.js'
import type { SqliteDatabase } from './driver.js'
import { MigrationError } from './errors.js'
import {
  appliedMigrations,
  applyMigrations,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  schemaVersion,
} from './migrations.js'

const dirs: string[] = []

async function scratch(): Promise<string> {
  const dir = await tempDir()
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

function tableNames(db: SqliteDatabase): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .pluck()
    .all() as string[]
}

function columnNames(db: SqliteDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.map((row) => row.name)
}

describe('migrations', () => {
  it('cria todas as tabelas do ARCHITECTURE 6.1 em banco novo', async () => {
    const handle = openDatabase({ path: join(await scratch(), 'state.db') })
    const names = tableNames(handle.db)
    for (const table of [
      'runs',
      'task_runs',
      'attempts',
      'gate_executions',
      'reviews',
      'events',
      'locks',
      'artifacts',
      'schema_migrations',
    ]) {
      expect(names).toContain(table)
    }
    handle.close()
  })

  it('registra versao, nome e data de cada migracao', async () => {
    const handle = openDatabase({ path: join(await scratch(), 'state.db') })
    const applied = appliedMigrations(handle.db)
    expect(applied.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version))
    expect(applied.map((m) => m.name)).toEqual(MIGRATIONS.map((m) => m.name))
    for (const migration of applied) expect(migration.appliedAt).toBeInstanceOf(Date)
    handle.close()
  })

  it('abrir duas vezes o mesmo banco nao duplica nem falha', async () => {
    const path = join(await scratch(), 'state.db')
    const first = openDatabase({ path })
    const firstCount = appliedMigrations(first.db).length
    first.close()

    const second = openDatabase({ path })
    expect(appliedMigrations(second.db).length).toBe(firstCount)
    expect(second.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    second.close()
  })

  it('applyMigrations em banco ja migrado nao aplica nada', async () => {
    const handle = openDatabase({ path: join(await scratch(), 'state.db') })
    expect(applyMigrations(handle.db)).toEqual([])
    expect(applyMigrations(handle.db)).toEqual([])
    expect(schemaVersion(handle.db)).toBe(LATEST_SCHEMA_VERSION)
    handle.close()
  })

  it('completa migracao pendente em banco parcialmente migrado', async () => {
    const path = join(await scratch(), 'state.db')
    const handle = openDatabase({ path, migrate: false })
    const first = MIGRATIONS[0]
    expect(first).toBeDefined()
    if (first === undefined) return

    applyMigrations(handle.db, [first])
    expect(schemaVersion(handle.db)).toBe(first.version)

    const applied = applyMigrations(handle.db)
    expect(applied.map((m) => m.version)).toEqual(
      MIGRATIONS.filter((m) => m.version > first.version).map((m) => m.version),
    )
    expect(schemaVersion(handle.db)).toBe(LATEST_SCHEMA_VERSION)
    handle.close()
  })

  it('preserva dado existente ao reabrir', async () => {
    const path = join(await scratch(), 'state.db')
    const first = openDatabase({ path })
    first.db
      .prepare(
        "INSERT INTO events (run_id, ts, type, actor, payload_json) VALUES ('r', 't', 'run.created', '{}', '{}')",
      )
      .run()
    first.close()

    const second = openDatabase({ path })
    const total = second.db.prepare('SELECT COUNT(*) AS total FROM events').get() as {
      total: number
    }
    expect(total.total).toBe(1)
    second.close()
  })

  it('events.seq usa AUTOINCREMENT', async () => {
    const handle = openDatabase({ path: join(await scratch(), 'state.db') })
    const sql = handle.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'")
      .pluck()
      .get() as string
    expect(sql).toContain('seq INTEGER PRIMARY KEY AUTOINCREMENT')
    handle.close()
  })

  it('as colunas de events sao as do documento', async () => {
    const handle = openDatabase({ path: join(await scratch(), 'state.db') })
    expect(columnNames(handle.db, 'events')).toEqual([
      'seq',
      'run_id',
      'ts',
      'type',
      'actor',
      'task_id',
      'attempt_id',
      'payload_json',
    ])
    handle.close()
  })

  it('as colunas de locks e artifacts sao as do documento', async () => {
    const handle = openDatabase({ path: join(await scratch(), 'state.db') })
    expect(columnNames(handle.db, 'locks')).toEqual([
      'run_id',
      'path_prefix',
      'attempt_id',
      'acquired_at',
    ])
    expect(columnNames(handle.db, 'artifacts')).toEqual([
      'id',
      'run_id',
      'kind',
      'path',
      'digest',
      'bytes',
      'created_at',
    ])
    handle.close()
  })

  it('task_runs tem chave primaria composta (run_id, task_id)', async () => {
    const handle = openDatabase({ path: join(await scratch(), 'state.db') })
    const rows = handle.db.prepare('PRAGMA table_info(task_runs)').all() as {
      name: string
      pk: number
    }[]
    const key = rows.filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk)
    expect(key.map((row) => row.name)).toEqual(['run_id', 'task_id'])
    handle.close()
  })

  it('cria as travas append-only como trigger', async () => {
    const handle = openDatabase({ path: join(await scratch(), 'state.db') })
    const triggers = handle.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .pluck()
      .all() as string[]
    expect(triggers).toEqual([
      'attempts_immutable_when_closed',
      'attempts_no_delete',
      'events_no_delete',
      'events_no_update',
    ])
    handle.close()
  })

  it('migracao que falha nao fica registrada', async () => {
    const handle = openDatabase({ path: join(await scratch(), 'state.db') })
    const broken = { version: 99, name: 'broken', sql: 'CREATE TABLE ;' }
    expect(() => applyMigrations(handle.db, [broken])).toThrow(MigrationError)
    expect(schemaVersion(handle.db)).toBe(LATEST_SCHEMA_VERSION)
    handle.close()
  })
})
