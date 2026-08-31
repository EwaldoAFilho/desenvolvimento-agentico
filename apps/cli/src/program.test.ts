import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Command } from 'commander'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureDeps,
  createWorkspace,
  MISSION_WITH_ERROR,
  type Workspace,
} from './__fixtures__/harness.js'
import type { BootedServer } from './deps.js'
import { envelopeOf, table, tristate } from './output.js'
import { buildProgram, main, withLaunchDefault } from './program.js'
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

const LAUNCH_URL = 'http://127.0.0.1:4317'

/** Servidor e navegador de mentira: a suite nao abre porta nem janela. */
function launcherDeps(dir: string): {
  readonly captured: ReturnType<typeof captureDeps>
  readonly ports: (number | undefined)[]
  readonly opens: string[]
} {
  const ports: (number | undefined)[] = []
  const opens: string[] = []
  const captured = captureDeps({
    cwd: dir,
    bootServer: (config): Promise<BootedServer> => {
      ports.push(config.port)
      return Promise.resolve({ url: LAUNCH_URL, close: () => Promise.resolve() })
    },
    openBrowser: (input) => {
      opens.push(input.url)
      return Promise.resolve({ opened: true, command: 'xdg-open' })
    },
  })
  return { captured, ports, opens }
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

describe('`agentic` sozinho e o launcher', () => {
  it('sem argumento nenhum abre o projeto do cwd e escreve no stdout', async () => {
    workspace = await createWorkspace()
    const { captured, opens } = launcherDeps(workspace.dir)

    const code = await main(argv(), captured.deps)

    expect(code).toBe(EXIT_OK)
    // O contrato antigo era ajuda no stderr e stdout vazio: nunca mais.
    expect(captured.stdout()).not.toBe('')
    expect(captured.stdout()).toContain(LAUNCH_URL)
    expect(captured.stderr()).toBe('')
    expect(opens).toEqual([LAUNCH_URL])
  })

  it('`agentic --no-open` nao abre navegador e continua servindo', async () => {
    workspace = await createWorkspace()
    const { captured, opens } = launcherDeps(workspace.dir)

    const code = await main(argv('--no-open'), captured.deps)

    expect(code).toBe(EXIT_OK)
    expect(opens).toEqual([])
    expect(captured.stdout()).toContain(`abra no navegador: ${LAUNCH_URL}`)
  })

  it('`agentic --port 5000` chega ao launcher com a porta', async () => {
    workspace = await createWorkspace()
    const { captured, ports } = launcherDeps(workspace.dir)

    const code = await main(argv('--port', '5000'), captured.deps)

    expect(code).toBe(EXIT_OK)
    expect(ports).toEqual([5000])
  })

  it('`agentic --json` emite o envelope do launcher', async () => {
    workspace = await createWorkspace()
    const { captured } = launcherDeps(workspace.dir)

    const code = await main(argv('--json'), captured.deps)

    expect(code).toBe(EXIT_OK)
    expect(captured.json()).toMatchObject({ ok: true, command: 'launch' })
  })

  it('`agentic launch` explicito faz a mesma coisa', async () => {
    workspace = await createWorkspace()
    const { captured, opens } = launcherDeps(workspace.dir)

    const code = await main(argv('launch'), captured.deps)

    expect(code).toBe(EXIT_OK)
    expect(opens).toEqual([LAUNCH_URL])
  })

  it('um operando continua sendo subcomando: o erro cita o que o usuario digitou', async () => {
    const captured = captureDeps()

    const code = await main(argv('doctro'), captured.deps)

    expect(code).toBe(EXIT_USAGE)
    expect(captured.stderr()).toContain('doctro')
  })

  it('a reescrita de argv so acontece quando nao ha subcomando', () => {
    expect(withLaunchDefault(argv())).toEqual(argv('launch'))
    expect(withLaunchDefault(argv('--no-open'))).toEqual(argv('launch', '--no-open'))
    expect(withLaunchDefault(argv('--port', '5000'))).toEqual(argv('launch', '--port', '5000'))
    expect(withLaunchDefault(argv('doctor'))).toEqual(argv('doctor'))
    expect(withLaunchDefault(argv('voar'))).toEqual(argv('voar'))
    // Ajuda e versao sao do programa, nao do launcher.
    expect(withLaunchDefault(argv('--help'))).toEqual(argv('--help'))
    expect(withLaunchDefault(argv('-h'))).toEqual(argv('-h'))
    expect(withLaunchDefault(argv('--version'))).toEqual(argv('--version'))
    expect(withLaunchDefault(argv('-v'))).toEqual(argv('-v'))
  })

  it('`--help` continua sendo ajuda do programa e anuncia o launcher', async () => {
    const captured = captureDeps()

    const code = await main(argv('--help'), captured.deps)

    expect(code).toBe(EXIT_OK)
    expect(captured.stdout()).toContain('launch')
    expect(captured.stdout()).toContain('navegador')
  })
})

/** `comando completo -> flags declaradas`, varrendo a arvore do commander. */
function optionsOf(command: Command, prefix = 'agentic'): Map<string, string[]> {
  const flags = command.options.flatMap((option) =>
    [option.short, option.long].filter((flag): flag is string => typeof flag === 'string'),
  )
  const out = new Map<string, string[]>([[prefix, flags]])
  for (const child of command.commands) {
    for (const [name, value] of optionsOf(child, `${prefix} ${child.name()}`)) out.set(name, value)
  }
  return out
}

/**
 * Superficie que EXISTIA antes do launcher. Nenhuma linha daqui pode sumir: o launcher e
 * adicao, e a CLI continua sendo o modo avancado do produto.
 */
const BASELINE: readonly (readonly [string, readonly string[]])[] = [
  ['agentic', ['-v', '--version']],
  ['agentic init', ['--json', '-C', '--project']],
  ['agentic mission validate', ['--json', '-C', '--project']],
  ['agentic mission compile', ['--json', '-C', '--project']],
  ['agentic mission approve', ['--json', '-C', '--project', '--port', '--actor', '--note']],
  [
    'agentic mission start',
    [
      '--json',
      '-C',
      '--project',
      '--port',
      '--accept-warnings',
      '--serve',
      '--no-serve',
      '--actor',
    ],
  ],
  ['agentic mission status', ['--json', '-C', '--project']],
  ['agentic mission pause', ['--json', '-C', '--project', '--port', '--actor', '--reason']],
  ['agentic mission resume', ['--json', '-C', '--project', '--port', '--actor', '--reason']],
  ['agentic mission stop', ['--json', '-C', '--project', '--port', '--actor', '--reason']],
  ['agentic serve', ['--json', '-C', '--project', '--port']],
  ['agentic task inspect', ['--json', '-C', '--project', '--run']],
  ['agentic task retry', ['--json', '-C', '--project', '--port', '--run', '--actor', '--reason']],
  ['agentic task unblock', ['--json', '-C', '--project', '--port', '--run', '--actor', '--note']],
  ['agentic task skip', ['--json', '-C', '--project', '--port', '--run', '--actor', '--reason']],
  ['agentic run report', ['--json', '-C', '--project', '--md']],
  ['agentic events tail', ['--json', '-C', '--project', '--since', '--limit', '--follow']],
  ['agentic providers', ['--json', '-C', '--project']],
  ['agentic doctor', ['--json', '-C', '--project']],
]

describe('nenhum subcomando ou opcao existente foi removido', () => {
  it('toda a superficie anterior continua declarada', () => {
    const declared = optionsOf(buildProgram(captureDeps().deps, { result: ok('agentic') }))

    for (const [command, flags] of BASELINE) {
      expect(declared.has(command), `sumiu o comando ${command}`).toBe(true)
      for (const flag of flags) {
        expect(declared.get(command), `sumiu ${flag} de ${command}`).toContain(flag)
      }
    }
  })

  it('o launcher e adicao: `launch` com `--no-open` e as opcoes comuns', () => {
    const declared = optionsOf(buildProgram(captureDeps().deps, { result: ok('agentic') }))

    expect(declared.get('agentic launch')).toEqual(
      expect.arrayContaining(['--json', '-C', '--project', '--port', '--no-open']),
    )
  })
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
