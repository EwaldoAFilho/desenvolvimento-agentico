import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  FAKE_BROKEN_CLI,
  FAKE_CLI,
  FAKE_DIR_CLI,
  FAKE_INERT_CLI,
  FAKE_LINKED_CLI,
  makeFakeCli,
  makeTempDir,
} from './__fixtures__/fake-cli.js'
import { brokenLinkTarget, isDirectory, isExecutableFile, resolveExecutable } from './resolve.js'

const cli = makeFakeCli()
const extras: string[] = []

afterAll(() => {
  for (const dir of extras) rmSync(dir, { recursive: true, force: true })
  rmSync(cli.dir, { recursive: true, force: true })
})

describe('resolveExecutable', () => {
  it('encontra o executavel no PATH', async () => {
    const found = await resolveExecutable(FAKE_CLI, { pathEnv: cli.dir, platform: 'linux' })
    expect(found).toEqual({ status: 'found', path: cli.path })
  })

  it('aceita caminho absoluto sem consultar o PATH', async () => {
    const found = await resolveExecutable(cli.path, { pathEnv: '', platform: 'linux' })
    expect(found).toEqual({ status: 'found', path: cli.path })
  })

  it('devolve not-found para executavel ausente', async () => {
    const missing = await resolveExecutable('cli-que-nao-existe-em-lugar-nenhum', {
      pathEnv: cli.dir,
      platform: 'linux',
    })
    expect(missing.status).toBe('not-found')
  })

  it('nao aceita diretorio homonimo como executavel', async () => {
    const result = await resolveExecutable(FAKE_DIR_CLI, { pathEnv: cli.dir, platform: 'linux' })
    expect(result.status).toBe('not-found')
  })

  it('nao aceita arquivo sem bit de execucao', async () => {
    const result = await resolveExecutable(FAKE_INERT_CLI, { pathEnv: cli.dir, platform: 'linux' })
    expect(result.status).toBe('not-found')
  })

  it('devolve unknown quando a propria checagem falha', async () => {
    const result = await resolveExecutable(FAKE_CLI, {
      pathEnv: cli.dir,
      platform: 'linux',
      isExecutableFile: () =>
        Promise.reject(Object.assign(new Error('disco fora'), { code: 'EIO' })),
    })
    expect(result.status).toBe('unknown')
    if (result.status !== 'unknown') throw new Error('esperava unknown')
    expect(result.detail).toContain('disco fora')
  })

  it('devolve unknown quando nao ha PATH para consultar', async () => {
    const result = await resolveExecutable(FAKE_CLI, { pathEnv: undefined, platform: 'linux' })
    expect(result.status).toBe('unknown')
  })

  it('devolve not-found para executavel vazio', async () => {
    const result = await resolveExecutable('   ', { pathEnv: cli.dir, platform: 'linux' })
    expect(result.status).toBe('not-found')
  })

  it('percorre todos os diretorios do PATH', async () => {
    const found = await resolveExecutable(FAKE_CLI, {
      pathEnv: `/nao/existe:${cli.dir}`,
      platform: 'linux',
    })
    expect(found).toEqual({ status: 'found', path: cli.path })
  })
})

describe('isExecutableFile', () => {
  it('distingue executavel, arquivo inerte e ausencia', async () => {
    expect(await isExecutableFile(cli.path)).toBe(true)
    expect(await isExecutableFile(join(cli.dir, FAKE_INERT_CLI))).toBe(false)
    expect(await isExecutableFile(join(cli.dir, 'nada-aqui'))).toBeNull()
  })
})

describe('isDirectory', () => {
  it('reconhece diretorio, arquivo e caminho ausente', async () => {
    expect(await isDirectory(cli.dir)).toBe(true)
    expect(await isDirectory(cli.path)).toBe(false)
    expect(await isDirectory(join(cli.dir, 'nao-existe'))).toBe(false)
  })
})

describe('resolveExecutable — symlink quebrado (o caso real)', () => {
  it('distingue link quebrado de caminho que nunca existiu, com alvo e remediacao', async () => {
    const result = await resolveExecutable(FAKE_BROKEN_CLI, {
      pathEnv: cli.dir,
      platform: 'linux',
    })
    expect(result.status).toBe('not-found')
    if (result.status !== 'not-found') throw new Error('esperava not-found')
    expect(result.diagnostic?.kind).toBe('broken-symlink')
    expect(result.diagnostic?.target).toBe(cli.brokenTarget)
    expect(result.diagnostic?.detail).toContain(cli.brokenPath)
    expect(result.diagnostic?.remediation ?? '').toContain(cli.brokenPath)
  })

  it('reconhece o link quebrado tambem por caminho absoluto', async () => {
    const result = await resolveExecutable(cli.brokenPath, { pathEnv: '', platform: 'linux' })
    expect(result.status).toBe('not-found')
    if (result.status !== 'not-found') throw new Error('esperava not-found')
    expect(result.diagnostic?.kind).toBe('broken-symlink')
    expect(result.diagnostic?.target).toBe(cli.brokenTarget)
  })

  it('symlink com alvo existente e instalacao valida, nao diagnostico', async () => {
    const result = await resolveExecutable(FAKE_LINKED_CLI, { pathEnv: cli.dir, platform: 'linux' })
    expect(result).toEqual({ status: 'found', path: cli.linkedPath })
  })

  it('link quebrado relativo aponta para o alvo resolvido contra o diretorio do link', async () => {
    const relativo = join(cli.dir, 'fake-relativo-cli')
    symlinkSync('./sumiu/binario', relativo)
    const result = await resolveExecutable(relativo, { pathEnv: '', platform: 'linux' })
    expect(result.status).toBe('not-found')
    if (result.status !== 'not-found') throw new Error('esperava not-found')
    expect(result.diagnostic?.kind).toBe('broken-symlink')
    expect(result.diagnostic?.target).toBe(join(cli.dir, 'sumiu', 'binario'))
  })
})

describe('resolveExecutable — diagnostico das demais falhas', () => {
  it('ausencia pura devolve diagnostico not-found sem alvo', async () => {
    const result = await resolveExecutable('cli-que-nao-existe-em-lugar-nenhum', {
      pathEnv: cli.dir,
      platform: 'linux',
    })
    if (result.status !== 'not-found') throw new Error('esperava not-found')
    expect(result.diagnostic?.kind).toBe('not-found')
    expect(result.diagnostic?.target).toBeUndefined()
  })

  it('arquivo sem bit de execucao devolve diagnostico not-executable apontando o arquivo', async () => {
    const result = await resolveExecutable(FAKE_INERT_CLI, { pathEnv: cli.dir, platform: 'linux' })
    if (result.status !== 'not-found') throw new Error('esperava not-found')
    expect(result.diagnostic?.kind).toBe('not-executable')
    expect(result.diagnostic?.target).toBe(join(cli.dir, FAKE_INERT_CLI))
  })

  it('diretorio homonimo tambem vira not-executable, nunca instalacao', async () => {
    const result = await resolveExecutable(FAKE_DIR_CLI, { pathEnv: cli.dir, platform: 'linux' })
    if (result.status !== 'not-found') throw new Error('esperava not-found')
    expect(result.diagnostic?.kind).toBe('not-executable')
  })

  it('falha da propria checagem vira diagnostico probe-failed com status unknown', async () => {
    const result = await resolveExecutable(FAKE_CLI, {
      pathEnv: cli.dir,
      platform: 'linux',
      isExecutableFile: () => Promise.reject(new Error('io quebrado')),
    })
    if (result.status !== 'unknown') throw new Error('esperava unknown')
    expect(result.diagnostic?.kind).toBe('probe-failed')
  })

  it('link quebrado vence arquivo inerte quando os dois estao no PATH', async () => {
    // O inerte aparece primeiro; ainda assim o diagnostico mais especifico prevalece.
    const antes = makeTempDir('agentic-inerte-')
    extras.push(antes)
    writeFileSync(join(antes, FAKE_BROKEN_CLI), '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    const result = await resolveExecutable(FAKE_BROKEN_CLI, {
      pathEnv: `${antes}:${cli.dir}`,
      platform: 'linux',
    })
    if (result.status !== 'not-found') throw new Error('esperava not-found')
    expect(result.diagnostic?.kind).toBe('broken-symlink')
    expect(result.diagnostic?.target).toBe(cli.brokenTarget)
  })
})

describe('brokenLinkTarget', () => {
  it('devolve o alvo inexistente de um symlink quebrado', async () => {
    expect(await brokenLinkTarget(cli.brokenPath)).toBe(cli.brokenTarget)
  })

  it('devolve null para symlink cujo alvo existe', async () => {
    expect(await brokenLinkTarget(cli.linkedPath)).toBeNull()
  })

  it('devolve null para arquivo comum e para caminho ausente', async () => {
    expect(await brokenLinkTarget(cli.path)).toBeNull()
    expect(await brokenLinkTarget(join(cli.dir, 'nada-aqui'))).toBeNull()
  })
})
