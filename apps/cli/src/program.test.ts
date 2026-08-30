import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureDeps,
  createWorkspace,
  MISSION_WITH_ERROR,
  type Workspace,
} from './__fixtures__/harness.js'
import { envelopeOf, table, tristate } from './output.js'
import { main } from './program.js'
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, failure, ok, usage } from './result.js'

const exec = promisify(execFile)
const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(CLI_DIR, 'bin/agentic.mjs')

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

function argv(...args: string[]): string[] {
  return ['node', 'agentic', ...args]
}

describe('program', () => {
  it('--help sai 0', async () => {
    const captured = captureDeps()
    const code = await main(argv('--help'), captured.deps)

    expect(code).toBe(EXIT_OK)
    expect(captured.stdout()).toContain('agentic')
  })

  it('comando desconhecido sai 2', async () => {
    const captured = captureDeps()
    const code = await main(argv('voar'), captured.deps)

    expect(code).toBe(EXIT_USAGE)
  })

  it('opcao desconhecida sai 2', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    const code = await main(argv('doctor', '--turbo'), captured.deps)

    expect(code).toBe(EXIT_USAGE)
  })

  it('mission validate pelo programa sai 0 e propaga o codigo ao exit', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    const code = await main(argv('mission', 'validate', workspace.missionPath), captured.deps)

    expect(code).toBe(EXIT_OK)
    expect(captured.exits()).toEqual([EXIT_OK])
  })

  it('--json chega ao handler pelo programa', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    const code = await main(
      argv('mission', 'validate', workspace.missionPath, '--json'),
      captured.deps,
    )

    expect(code).toBe(EXIT_OK)
    expect(captured.json()).toMatchObject({ ok: true, command: 'mission validate' })
  })

  it('task unblock sem --note sai 2 pelo programa', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    const code = await main(
      argv('task', 'unblock', 'T01', '--run', '01J0000000000000000000000A'),
      captured.deps,
    )

    expect(code).toBe(EXIT_USAGE)
    expect(captured.stderr()).toContain('--note')
  })

  it('falha de comando com --json sai 1 e emite o envelope de erro', async () => {
    workspace = await createWorkspace({ mission: MISSION_WITH_ERROR })
    const captured = captureDeps({ cwd: workspace.dir })
    const code = await main(
      argv('mission', 'validate', workspace.missionPath, '--json'),
      captured.deps,
    )

    expect(code).toBe(EXIT_ERROR)
    expect(captured.json()).toMatchObject({
      ok: false,
      command: 'mission validate',
      error: { code: 'VALIDATION_FAILED' },
    })
  })

  it('--port nao numerico e erro de uso', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    const code = await main(argv('serve', '--port', 'abc'), captured.deps)

    expect(code).toBe(EXIT_USAGE)
  })

  // Smoke do binario de verdade: shebang, import do dist e codigo de saida. Pulado (nao
  // silenciosamente reprovado) quando `npm run build -w @agentic/cli` ainda nao rodou.
  it('smoke do binario: --help sai 0', async (context) => {
    let compiled = true
    try {
      await access(join(CLI_DIR, 'dist/index.js'))
    } catch {
      compiled = false
    }
    if (!compiled) {
      context.skip()
      return
    }
    const { stdout } = await exec(process.execPath, [BIN, '--help'], { encoding: 'utf8' })
    expect(stdout).toContain('agentic')
    expect(stdout).toContain('mission')
  }, 60_000)
})

describe('contrato de saida', () => {
  it('o envelope --json tem forma estavel no sucesso e na falha', () => {
    expect(envelopeOf(ok('doctor', { a: 1 }))).toEqual({
      ok: true,
      command: 'doctor',
      data: { a: 1 },
    })
    expect(envelopeOf(failure('doctor', 'X', 'y'))).toEqual({
      ok: false,
      command: 'doctor',
      error: { code: 'X', message: 'y' },
    })
    expect(usage('doctor', 'z').exitCode).toBe(EXIT_USAGE)
    expect(failure('doctor', 'X', 'y').exitCode).toBe(EXIT_ERROR)
  })

  it('tristate imprime unknown como unknown', () => {
    expect(tristate('unknown')).toBe('unknown')
    expect(tristate(true)).toBe('sim')
    expect(tristate(false)).toBe('nao')
  })

  it('a tabela alinha colunas sem cor nem simbolo', () => {
    expect(table(['A', 'BB'], [['x', 'yyy']])).toEqual(['A  BB', 'x  yyy'])
  })
})
