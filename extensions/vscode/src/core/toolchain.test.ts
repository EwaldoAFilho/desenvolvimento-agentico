import { describe, expect, it } from 'vitest'
import {
  childEnv,
  majorOf,
  resolveCli,
  resolveNode,
  resolveToolchain,
  ToolchainError,
  type ToolchainIo,
} from './toolchain.js'

interface FakeFs {
  readonly files: Set<string>
  readonly versions: Record<string, string>
}

function io(fs: FakeFs, env: Record<string, string | undefined> = {}): ToolchainIo {
  return {
    exists: (path) => Promise.resolve(fs.files.has(path)),
    readdir: (path) =>
      Promise.resolve(
        [...fs.files]
          .filter((f) => f.startsWith(`${path}/`))
          .map((f) => f.slice(path.length + 1).split('/')[0] ?? '')
          .filter((f, i, all) => all.indexOf(f) === i),
      ),
    realpath: (path) => Promise.resolve(path),
    exec: (command) => {
      const version = fs.versions[command]
      if (version === undefined) return Promise.reject(new Error('ENOENT'))
      return Promise.resolve({ code: 0, stdout: `${version}\n`, stderr: '' })
    },
    env: { PATH: '/usr/bin', ...env },
    homedir: '/home/u',
    platform: 'linux',
  }
}

describe('resolveNode', () => {
  it('node do PATH serve quando e >= 22', async () => {
    const node = await resolveNode(io({ files: new Set(), versions: { node: 'v22.23.1' } }))
    expect(node).toEqual({ path: 'node', version: 'v22.23.1' })
  })

  it('PATH em node 20 nao serve; o nvm mais novo >= 22 e escolhido', async () => {
    const fs: FakeFs = {
      files: new Set([
        '/home/u/.nvm/versions/node',
        '/home/u/.nvm/versions/node/v20.19.0/bin/node',
        '/home/u/.nvm/versions/node/v22.23.1/bin/node',
        '/home/u/.nvm/versions/node/v24.1.0/bin/node',
      ]),
      versions: {
        node: 'v20.19.0',
        '/home/u/.nvm/versions/node/v24.1.0/bin/node': 'v24.1.0',
        '/home/u/.nvm/versions/node/v22.23.1/bin/node': 'v22.23.1',
      },
    }
    const node = await resolveNode(io(fs))
    expect(node.path).toBe('/home/u/.nvm/versions/node/v24.1.0/bin/node')
  })

  it('configuracao explicita vem primeiro', async () => {
    const node = await resolveNode(
      io({ files: new Set(), versions: { node: 'v20.0.0', '/opt/node': 'v22.0.0' } }),
      {
        nodePath: '/opt/node',
      },
    )
    expect(node.path).toBe('/opt/node')
  })

  it('so node velho: erro NODE_TOO_OLD com a versao encontrada', async () => {
    const error = await resolveNode(io({ files: new Set(), versions: { node: 'v20.19.0' } })).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(ToolchainError)
    expect((error as ToolchainError).code).toBe('NODE_TOO_OLD')
    expect((error as Error).message).toContain('v20.19.0')
  })

  it('nenhum node: NODE_NOT_FOUND', async () => {
    const error = await resolveNode(io({ files: new Set(), versions: {} })).catch((e: unknown) => e)
    expect((error as ToolchainError).code).toBe('NODE_NOT_FOUND')
  })

  it('majorOf le v22.1.0 e 22.1.0', () => {
    expect(majorOf('v22.1.0')).toBe(22)
    expect(majorOf('22.1.0')).toBe(22)
    expect(majorOf('lixo')).toBeUndefined()
  })
})

describe('resolveCli', () => {
  it('no monorepo, a CLI do proprio repositorio e um script para o node escolhido', async () => {
    const cli = await resolveCli(
      io({ files: new Set(['/repo/apps/cli/bin/agentic.mjs']), versions: {} }),
      '/repo',
    )
    expect(cli).toEqual({ kind: 'script', path: '/repo/apps/cli/bin/agentic.mjs', source: 'repo' })
  })

  it('depois node_modules/.bin, depois o PATH', async () => {
    const viaModules = await resolveCli(
      io({ files: new Set(['/repo/node_modules/.bin/agentic']), versions: {} }),
      '/repo',
    )
    expect(viaModules.source).toBe('node_modules')
    const viaPath = await resolveCli(
      io({ files: new Set(['/usr/bin/agentic']), versions: {} }),
      '/repo',
    )
    expect(viaPath).toEqual({ kind: 'binary', path: '/usr/bin/agentic', source: 'path' })
  })

  it('nada encontrado: CLI_NOT_FOUND apontando a configuracao', async () => {
    const error = await resolveCli(io({ files: new Set(), versions: {} }), '/repo').catch(
      (e: unknown) => e,
    )
    expect((error as ToolchainError).code).toBe('CLI_NOT_FOUND')
    expect((error as Error).message).toContain('agentic.cliPath')
  })
})

describe('resolveToolchain', () => {
  it('monta a linha de comando: node + script + args', async () => {
    const toolchain = await resolveToolchain(
      io({ files: new Set(['/repo/apps/cli/bin/agentic.mjs']), versions: { node: 'v22.0.0' } }),
      '/repo',
    )
    expect(toolchain.command(['serve', '-C', '/repo'])).toEqual({
      file: 'node',
      args: ['/repo/apps/cli/bin/agentic.mjs', 'serve', '-C', '/repo'],
    })
  })

  it('PATH do filho leva o diretorio do node escolhido na frente', () => {
    expect(childEnv({ PATH: '/usr/bin' }, { path: '/opt/n/bin/node', version: 'v22' }).PATH).toBe(
      '/opt/n/bin:/usr/bin',
    )
    expect(childEnv({ PATH: '/usr/bin' }, { path: 'node', version: 'v22' }).PATH).toBe('/usr/bin')
  })
})
