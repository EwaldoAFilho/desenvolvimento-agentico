import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FAKE_CLI, FAKE_DIR_CLI, FAKE_INERT_CLI, makeFakeCli } from './__fixtures__/fake-cli.js'
import { isDirectory, isExecutableFile, resolveExecutable } from './resolve.js'

const cli = makeFakeCli()

afterAll(() => {
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
