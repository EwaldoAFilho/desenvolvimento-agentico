import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RUN_B, run, taskRun, tempDir } from './__fixtures__/builders.js'
import { busyTimeout, journalMode, openDatabase } from './database.js'
import { ReadOnlyDatabaseError } from './errors.js'
import { LATEST_SCHEMA_VERSION } from './migrations.js'
import { createRunStore } from './run-store.js'
import { writeRun } from './writes.js'

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

describe('openDatabase', () => {
  it('abre o banco de escrita em WAL', async () => {
    const handle = openDatabase({ path: join(await scratch(), 'state.db') })
    expect(journalMode(handle.db)).toBe('wal')
    handle.close()
  })

  it('aplica o busy_timeout pedido', async () => {
    const handle = openDatabase({ path: join(await scratch(), 'state.db'), busyTimeoutMs: 1234 })
    expect(busyTimeout(handle.db)).toBe(1234)
    handle.close()
  })

  it('cria o diretorio do arquivo quando ele nao existe', async () => {
    const path = join(await scratch(), 'nested', 'deep', 'state.db')
    const handle = openDatabase({ path })
    expect(existsSync(path)).toBe(true)
    handle.close()
  })

  it('migra na abertura e reporta a versao corrente', async () => {
    const handle = openDatabase({ path: join(await scratch(), 'state.db') })
    expect(handle.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    handle.close()
  })

  it('modo readonly exige que o arquivo exista', async () => {
    const path = join(await scratch(), 'ausente.db')
    expect(() => openDatabase({ path, mode: 'readonly' })).toThrow()
  })

  it('conexao readonly nao aceita escrita', async () => {
    const path = join(await scratch(), 'state.db')
    const writer = openDatabase({ path })
    const reader = openDatabase({ path, mode: 'readonly' })
    const store = createRunStore(reader)

    await expect(store.withTransaction(async () => undefined)).rejects.toBeInstanceOf(
      ReadOnlyDatabaseError,
    )

    reader.close()
    writer.close()
  })

  it('close e idempotente', async () => {
    const handle = openDatabase({ path: join(await scratch(), 'state.db') })
    handle.close()
    expect(() => {
      handle.close()
    }).not.toThrow()
  })
})

describe('leitura concorrente (WAL)', () => {
  it('a conexao readonly le estado consistente enquanto a readwrite escreve', async () => {
    const path = join(await scratch(), 'state.db')
    const writer = openDatabase({ path })
    const store = createRunStore(writer)
    await store.createRun(run(), [taskRun()])

    const reader = openDatabase({ path, mode: 'readonly' })
    const countRuns = (): number =>
      (reader.db.prepare('SELECT COUNT(*) AS total FROM runs').get() as { total: number }).total

    expect(countRuns()).toBe(1)

    // Dentro da transacao de escrita o leitor continua vendo o snapshot anterior.
    writer.db
      .transaction(() => {
        writeRun(writer.db, run({ id: RUN_B }))
        expect(countRuns()).toBe(1)
      })
      .immediate()

    expect(countRuns()).toBe(2)

    reader.close()
    writer.close()
  })

  it('o leitor enxerga evento novo sem reabrir a conexao', async () => {
    const path = join(await scratch(), 'state.db')
    const writer = openDatabase({ path })
    const store = createRunStore(writer)
    await store.createRun(run(), [taskRun()])

    const reader = openDatabase({ path, mode: 'readonly' })
    const countEvents = (): number =>
      (reader.db.prepare('SELECT COUNT(*) AS total FROM events').get() as { total: number }).total
    const before = countEvents()

    await store.withTransaction(async (uow) => {
      await uow.appendEvent({
        runId: run().id,
        ts: new Date(),
        type: 'run.paused',
        actor: { kind: 'human', id: 'ewaldo' },
        payload: { reason: 'cafe' },
      })
    })

    expect(countEvents()).toBe(before + 1)

    reader.close()
    writer.close()
  })
})
