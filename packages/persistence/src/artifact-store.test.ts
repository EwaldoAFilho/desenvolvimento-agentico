import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NOW,
  RUN,
  seededRun,
  type TempPersistence,
  tempPersistence,
} from './__fixtures__/builders.js'
import { RUNS_DIRECTORY } from './artifact-store.js'
import { ArtifactNotFoundError, ArtifactPathError } from './errors.js'

let temp: TempPersistence

const PATCH = 'attempts/T01-a1/patch.diff'
const CONTENT = 'diff --git a/x b/x\n+linha nova\n'

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

beforeEach(async () => {
  temp = await tempPersistence()
  await seededRun(temp.persistence)
})

afterEach(async () => {
  await temp.dispose()
})

describe('ArtifactStore.write', () => {
  it('devolve caminho, digest sha256 e bytes', async () => {
    const record = await temp.persistence.artifacts.write({
      runId: RUN,
      kind: 'patch',
      relativePath: PATCH,
      content: CONTENT,
      createdAt: NOW,
    })

    expect(record.path).toBe(`${RUNS_DIRECTORY}/${RUN}/${PATCH}`)
    expect(record.digest).toBe(sha256(CONTENT))
    expect(record.bytes).toBe(Buffer.byteLength(CONTENT, 'utf8'))
    expect(record.createdAt.getTime()).toBe(NOW.getTime())
    expect(record.kind).toBe('patch')
  })

  it('grava sob .agentic/runs/<runId>/ dentro do diretorio base', async () => {
    const store = temp.persistence.artifacts
    const record = await store.write({
      runId: RUN,
      kind: 'log',
      relativePath: 'attempts/T01-a1/agent.log.jsonl',
      content: '{"ok":true}\n',
    })

    expect(isAbsolute(record.absolutePath)).toBe(true)
    expect(record.absolutePath.startsWith(store.baseDir + sep)).toBe(true)
    expect(record.absolutePath).toBe(
      join(store.baseDir, RUNS_DIRECTORY, RUN, 'attempts', 'T01-a1', 'agent.log.jsonl'),
    )
    expect(await readFile(record.absolutePath, 'utf8')).toBe('{"ok":true}\n')
  })

  it('registra o artefato na tabela artifacts', async () => {
    const store = temp.persistence.artifacts
    await store.write({ runId: RUN, kind: 'patch', relativePath: PATCH, content: CONTENT })

    const rows = store.list(RUN)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('patch')
    expect(rows[0]?.digest).toBe(sha256(CONTENT))
    expect(rows[0]?.bytes).toBe(Buffer.byteLength(CONTENT, 'utf8'))
    expect(rows[0]?.path).toBe(`${RUNS_DIRECTORY}/${RUN}/${PATCH}`)
  })

  it('le o conteudo de volta identico', async () => {
    const store = temp.persistence.artifacts
    await store.write({ runId: RUN, kind: 'patch', relativePath: PATCH, content: CONTENT })

    expect(await store.readText(RUN, PATCH)).toBe(CONTENT)
    expect(await store.readText(RUN, `${RUNS_DIRECTORY}/${RUN}/${PATCH}`)).toBe(CONTENT)
  })

  it('faz round-trip de conteudo binario', async () => {
    const store = temp.persistence.artifacts
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    const record = await store.write({
      runId: RUN,
      kind: 'blob',
      relativePath: 'artifacts/bin.dat',
      content: bytes,
    })

    expect(record.digest).toBe(sha256(bytes))
    expect(record.bytes).toBe(6)
    const back = await store.read(RUN, 'artifacts/bin.dat')
    expect(Uint8Array.from(back)).toEqual(bytes)
  })

  it('le por id', async () => {
    const store = temp.persistence.artifacts
    const record = await store.write({
      runId: RUN,
      kind: 'patch',
      relativePath: PATCH,
      content: CONTENT,
    })
    expect((await store.readById(record.id)).toString('utf8')).toBe(CONTENT)
    expect(store.get(record.id)?.path).toBe(record.path)
  })

  it('regravar o mesmo caminho atualiza digest e bytes', async () => {
    const store = temp.persistence.artifacts
    await store.write({ runId: RUN, kind: 'patch', relativePath: PATCH, content: CONTENT })
    const second = await store.write({
      runId: RUN,
      kind: 'patch',
      relativePath: PATCH,
      content: 'outro conteudo',
    })

    expect(store.list(RUN)).toHaveLength(1)
    expect(second.digest).toBe(sha256('outro conteudo'))
    expect(second.bytes).toBe(14)
    expect(await store.readText(RUN, PATCH)).toBe('outro conteudo')
  })

  it('cria diretorio aninhado sob o run', async () => {
    const store = temp.persistence.artifacts
    const record = await store.write({
      runId: RUN,
      kind: 'gate',
      relativePath: 'attempts/T02-a3/gate-core.stdout',
      content: 'ok',
    })
    expect(await readFile(record.absolutePath, 'utf8')).toBe('ok')
  })
})

describe('contencao de caminho', () => {
  it('rejeita caminho que sobe para fora do run', async () => {
    const store = temp.persistence.artifacts
    await expect(
      store.write({
        runId: RUN,
        kind: 'patch',
        relativePath: '../../escapou.txt',
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(ArtifactPathError)
  })

  it('rejeita caminho absoluto', async () => {
    const store = temp.persistence.artifacts
    await expect(
      store.write({ runId: RUN, kind: 'patch', relativePath: '/etc/passwd', content: 'x' }),
    ).rejects.toBeInstanceOf(ArtifactPathError)
  })

  it('rejeita caminho vazio e o proprio diretorio do run', async () => {
    const store = temp.persistence.artifacts
    expect(() => store.resolvePath(RUN, '   ')).toThrow(ArtifactPathError)
    expect(() => store.resolvePath(RUN, '.')).toThrow(ArtifactPathError)
  })

  it('artefato ausente levanta ArtifactNotFoundError', async () => {
    const store = temp.persistence.artifacts
    await expect(store.read(RUN, 'nao/existe.txt')).rejects.toBeInstanceOf(ArtifactNotFoundError)
    await expect(store.readById('nao-existe')).rejects.toBeInstanceOf(ArtifactNotFoundError)
  })
})
