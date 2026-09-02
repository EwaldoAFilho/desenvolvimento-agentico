import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A extensao e CLIENTE: o bundle que vai para o editor nao pode carregar o core. Este teste
 * compila `src/extension.ts` de verdade (esbuild, como o build) e procura, no resultado, as
 * marcas de quem NAO pode estar la: o servidor HTTP, o driver SQLite, o orquestrador.
 */
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
let out = ''
let bundle = ''

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'agentic-vscode-bundle-'))
  await build({
    entryPoints: [join(root, 'src/extension.ts')],
    outfile: join(out, 'extension.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['vscode'],
    logLevel: 'silent',
  })
  bundle = await readFile(join(out, 'extension.js'), 'utf8')
})

afterAll(async () => {
  await rm(out, { recursive: true, force: true })
})

describe('bundle da extensao', () => {
  it('nao contem o core: nem servidor, nem banco, nem orquestrador', () => {
    // O NOME `better-sqlite3` aparece de proposito (a sonda da toolchain abre um banco com o
    // driver do PROJETO, num processo filho); o que nao pode aparecer e o CODIGO do driver.
    for (const marker of [
      'fastify',
      'SqliteError',
      'better_sqlite3.node',
      'createControlPlane(',
      'BEGIN EXCLUSIVE',
      'registerReadRoutes',
    ]) {
      expect(bundle, `marca proibida no bundle: ${marker}`).not.toContain(marker)
    }
  })

  it('nao le nem injeta credencial (P17)', () => {
    for (const marker of ['API_KEY', 'ANTHROPIC_', 'OPENAI_', 'Authorization']) {
      expect(bundle).not.toContain(marker)
    }
  })

  it('e pequeno o bastante para ser so uma casca', () => {
    expect(bundle.length).toBeLessThan(300_000)
  })
})
