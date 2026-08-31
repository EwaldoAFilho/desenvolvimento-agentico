import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerConfig } from '@agentic/server'
import { afterEach, describe, expect, it } from 'vitest'
import { captureDeps, createWorkspace, type Workspace } from '../__fixtures__/harness.js'
import type { BrowserOutcome, OpenBrowserInput } from '../browser.js'
import type { BootedServer } from '../deps.js'
import { main } from '../program.js'
import { EXIT_ERROR, EXIT_OK } from '../result.js'
import { type LaunchData, launchCommand } from './launch.js'

const PRODUCT_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const ENDPOINT = 'http://127.0.0.1:4317'

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

interface BootSpy {
  readonly configs: ServerConfig[]
  readonly closed: () => number
  readonly boot: (config: ServerConfig) => Promise<BootedServer>
}

/** Servidor de mentira: nenhuma porta e aberta durante a suite. */
function bootSpy(url = ENDPOINT): BootSpy {
  const configs: ServerConfig[] = []
  let closes = 0
  return {
    configs,
    closed: () => closes,
    boot: (config) => {
      configs.push(config)
      return Promise.resolve({
        url,
        close: () => {
          closes += 1
          return Promise.resolve()
        },
      })
    },
  }
}

interface OpenSpy {
  readonly inputs: OpenBrowserInput[]
  readonly open: (input: OpenBrowserInput) => Promise<BrowserOutcome>
}

/** Abridor de mentira: nenhum navegador de verdade abre durante a suite. */
function openSpy(outcome: BrowserOutcome = { opened: true, command: 'xdg-open' }): OpenSpy {
  const inputs: OpenBrowserInput[] = []
  return {
    inputs,
    open: (input) => {
      inputs.push(input)
      return Promise.resolve(outcome)
    },
  }
}

const dataOf = (result: { readonly data?: unknown }): LaunchData => result.data as LaunchData

describe('o projeto e o diretorio de onde o comando foi chamado', () => {
  it('usa o cwd como projeto-alvo, nunca o repositorio do produto', async () => {
    workspace = await createWorkspace()
    const boot = bootSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: boot.boot,
      openBrowser: openSpy().open,
    })

    const result = await launchCommand({}, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(dataOf(result).projectDir).toBe(workspace.dir)
    expect(dataOf(result).projectDir).not.toBe(PRODUCT_REPO)
    // O servidor tambem tem que apontar para o projeto do usuario, nao para o produto.
    expect(boot.configs[0]?.projectFile).toBe(join(workspace.dir, '.agentic', 'project.yaml'))
    expect(boot.configs[0]?.runtimeDir).toBe(join(workspace.dir, '.agentic'))
  })

  it('diretorio sem `.agentic` recusa e manda rodar `agentic init` — nao cai no produto', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'agentic-sem-projeto-'))
    const boot = bootSpy()
    const captured = captureDeps({
      cwd: empty,
      bootServer: boot.boot,
      openBrowser: openSpy().open,
    })

    try {
      const code = await main(['node', 'agentic'], captured.deps)

      expect(code).toBe(EXIT_ERROR)
      expect(captured.stderr()).toContain('PROJECT_NOT_FOUND')
      expect(captured.stderr()).toContain('agentic init')
      expect(captured.stderr()).toContain(empty)
      expect(boot.configs).toHaveLength(0)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('`--project` continua escolhendo outro diretorio', async () => {
    workspace = await createWorkspace()
    const boot = bootSpy()
    const captured = captureDeps({
      cwd: tmpdir(),
      bootServer: boot.boot,
      openBrowser: openSpy().open,
    })

    const result = await launchCommand({ project: workspace.dir }, captured.deps)

    expect(dataOf(result).projectDir).toBe(workspace.dir)
  })
})

describe('control plane: reaproveita, nunca duplica', () => {
  it('control plane no ar e reaproveitado e nada novo e subido', async () => {
    workspace = await createWorkspace()
    const boot = bootSpy()
    const opener = openSpy()
    let waited = false
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: boot.boot,
      openBrowser: opener.open,
      connect: () =>
        Promise.resolve({
          endpoint: ENDPOINT,
          // Fake honesto: responde SO no caminho real. Path errado = 404, como no servidor.
          send: (request) =>
            Promise.resolve(
              request.path === '/api/health'
                ? { status: 200, body: { status: 'ok', repoRoot: workspace?.dir } }
                : { status: 404, body: {} },
            ),
        }),
      waitForShutdown: () => {
        waited = true
        return Promise.resolve()
      },
    })

    const result = await launchCommand({}, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(dataOf(result).reused).toBe(true)
    // Um segundo control plane seria um segundo escritor no mesmo banco (I7).
    expect(boot.configs).toHaveLength(0)
    expect(captured.stdout()).toContain('ja no ar')
    // Quem serve e outro processo: este nao pode ficar segurando o terminal.
    expect(waited).toBe(false)
    expect(opener.inputs[0]?.url).toBe(ENDPOINT)
  })

  it('sem control plane no ar, sobe um e fica em primeiro plano ate o encerramento', async () => {
    workspace = await createWorkspace()
    const boot = bootSpy()
    let waited = false
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: boot.boot,
      openBrowser: openSpy().open,
      waitForShutdown: () => {
        waited = true
        return Promise.resolve()
      },
    })

    const result = await launchCommand({}, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(dataOf(result).reused).toBe(false)
    expect(boot.configs).toHaveLength(1)
    expect(waited).toBe(true)
    expect(boot.closed()).toBe(1)
    expect(captured.stdout()).toContain(ENDPOINT)
    expect(captured.stdout()).toContain('Ctrl+C')
  })

  it('`--port` decide o endereco', async () => {
    workspace = await createWorkspace()
    const boot = bootSpy('http://127.0.0.1:5000')
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: boot.boot,
      openBrowser: openSpy().open,
    })

    await launchCommand({ port: 5000 }, captured.deps)

    expect(boot.configs[0]?.port).toBe(5000)
  })

  it('control plane que nao sobe vira erro com alternativa, nao stack solta', async () => {
    workspace = await createWorkspace()
    const opener = openSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: () => Promise.reject(new Error('EADDRINUSE 4317')),
      openBrowser: opener.open,
    })

    const result = await launchCommand({}, captured.deps)

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(result.error?.code).toBe('SERVER_UNAVAILABLE')
    expect(result.error?.message).toContain('EADDRINUSE')
    expect(captured.stdout()).toContain('npm start -w @agentic/server')
    // Nao ha o que abrir: nenhuma URL respondendo.
    expect(opener.inputs).toHaveLength(0)
  })
})

describe('navegador', () => {
  it('abre na URL do control plane e diz o que rodou', async () => {
    workspace = await createWorkspace()
    const opener = openSpy({ opened: true, command: `xdg-open ${ENDPOINT}` })
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: bootSpy().boot,
      openBrowser: opener.open,
      platform: 'linux',
      env: { DISPLAY: ':0' },
    })

    const result = await launchCommand({}, captured.deps)

    expect(dataOf(result).browser.opened).toBe(true)
    expect(captured.stdout()).toContain(`navegador aberto em ${ENDPOINT}`)
    // A decisao de ambiente e do abridor: ele precisa receber plataforma e ambiente reais.
    expect(opener.inputs[0]?.platform).toBe('linux')
    expect(opener.inputs[0]?.env).toEqual({ DISPLAY: ':0' })
    expect(opener.inputs[0]?.cwd).toBe(workspace.dir)
  })

  it('ambiente sem GUI nao abre nada e informa a URL', async () => {
    workspace = await createWorkspace()
    const opener = openSpy({ opened: false, reason: 'sem DISPLAY nem WAYLAND_DISPLAY' })
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: bootSpy().boot,
      openBrowser: opener.open,
    })

    const result = await launchCommand({}, captured.deps)

    // Headless nao e falha: o control plane subiu e a jornada continua pela URL.
    expect(result.exitCode).toBe(EXIT_OK)
    expect(dataOf(result).browser.opened).toBe(false)
    expect(captured.stdout()).toContain('navegador nao aberto: sem DISPLAY')
    expect(captured.stdout()).toContain(`abra no navegador: ${ENDPOINT}`)
  })

  it('`--no-open` nem chama o abridor, e ainda assim informa a URL', async () => {
    workspace = await createWorkspace()
    const opener = openSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: bootSpy().boot,
      openBrowser: opener.open,
      platform: 'linux',
      env: { DISPLAY: ':0' },
    })

    const result = await launchCommand({ open: false }, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(opener.inputs).toHaveLength(0)
    expect(dataOf(result).browser).toEqual({ opened: false, reason: '--no-open' })
    expect(captured.stdout()).toContain(`abra no navegador: ${ENDPOINT}`)
  })

  it('abridor que falha nao derruba o launcher', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: bootSpy().boot,
      openBrowser: () =>
        Promise.resolve({ opened: false, reason: 'xdg-open indisponivel: spawn ENOENT' }),
    })

    const result = await launchCommand({}, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(captured.stdout()).toContain('spawn ENOENT')
  })

  it('sem abridor injetado a suite continua sem abrir navegador de verdade', async () => {
    // `captureDeps` nao declara plataforma: o abridor real recusa antes de tocar o SO.
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir, bootServer: bootSpy().boot })

    const result = await launchCommand({}, captured.deps)

    expect(dataOf(result).browser.opened).toBe(false)
    expect(dataOf(result).browser.reason).toContain('plataforma')
  })
})

describe('diagnostico do ambiente', () => {
  it('ambiente saudavel: node, arquivos do projeto e git', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: bootSpy().boot,
      openBrowser: openSpy().open,
    })

    const result = await launchCommand({}, captured.deps)

    expect(dataOf(result).checks.map((check) => check.id)).toEqual([
      'node.version',
      'project.files',
      'git.installed',
      'git.repository',
    ])
    expect(dataOf(result).checks.every((check) => check.status === 'ok')).toBe(true)
  })

  it('node velho e reportado como ERRO, mas a tela ainda abre', async () => {
    workspace = await createWorkspace()
    const boot = bootSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      nodeVersion: '18.20.0',
      bootServer: boot.boot,
      openBrowser: openSpy().open,
    })

    const result = await launchCommand({}, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(dataOf(result).checks[0]?.status).toBe('error')
    expect(captured.stdout()).toContain('agentic doctor')
    // A Home e onde o problema aparece: esconder a tela esconderia o diagnostico.
    expect(boot.configs).toHaveLength(1)
  })

  it('git ausente com workspace git-worktree e ERRO', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: bootSpy().boot,
      openBrowser: openSpy().open,
      probeGit: () =>
        Promise.resolve({
          installed: false,
          version: 'unknown',
          repository: false,
          detail: 'command not found',
        }),
    })

    const result = await launchCommand({}, captured.deps)

    const checks = dataOf(result).checks
    expect(checks.find((check) => check.id === 'git.installed')?.status).toBe('error')
    expect(checks.find((check) => check.id === 'git.repository')?.status).toBe('error')
  })

  it('fora de repositorio git no modo shared e aviso, nao erro', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: bootSpy().boot,
      openBrowser: openSpy().open,
      probeGit: () =>
        Promise.resolve({
          installed: true,
          version: 'git version 2.43.0',
          repository: false,
          detail: 'fora de um repositorio',
        }),
    })

    const result = await launchCommand({}, captured.deps)

    const checks = dataOf(result).checks
    expect(checks.find((check) => check.id === 'git.repository')?.status).toBe('warn')
    expect(captured.stdout()).not.toContain('problema(s) de ambiente')
  })
})

describe('`agentic serve` nao muda', () => {
  it('serve nao abre navegador', async () => {
    workspace = await createWorkspace()
    const opener = openSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: bootSpy().boot,
      openBrowser: opener.open,
    })

    const code = await main(['node', 'agentic', 'serve'], captured.deps)

    expect(code).toBe(EXIT_OK)
    expect(opener.inputs).toHaveLength(0)
    expect(captured.stdout()).toContain('control plane no ar em')
    expect(captured.stdout()).toContain('START MISSION')
  })

  it('serve nao aceita `--no-open`: a flag e do launcher', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir, bootServer: bootSpy().boot })

    const code = await main(['node', 'agentic', 'serve', '--no-open'], captured.deps)

    expect(code).toBe(2)
  })
})

/**
 * Os dois defeitos que reprovaram U02 tres vezes na revisao independente, e que a task nao
 * conseguia fechar sozinha: `resolveEndpoint` vive em discovery.ts, fora do `touches` dela.
 */
describe('launcher: identidade do plane e precedencia de --port', () => {
  it('nao adota control plane que serve OUTRO projeto na mesma porta', async () => {
    workspace = await createWorkspace()
    const boot = bootSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: boot.boot,
      openBrowser: openSpy().open,
      waitForShutdown: () => Promise.resolve(),
      connect: () =>
        Promise.resolve({
          endpoint: ENDPOINT,
          send: () =>
            Promise.resolve({
              status: 200,
              body: { status: 'ok', repoRoot: '/tmp/projeto-alheio' },
            }),
        }),
    })

    const result = await launchCommand({}, captured.deps)

    // Reusar seria operar o control plane do projeto errado — o defeito historico da secao 36.
    expect(dataOf(result).reused).toBe(false)
    expect(boot.configs).toHaveLength(1)
  })

  it('sem prova de identidade no /health, nao reaproveita', async () => {
    workspace = await createWorkspace()
    const boot = bootSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: boot.boot,
      openBrowser: openSpy().open,
      waitForShutdown: () => Promise.resolve(),
      connect: () =>
        Promise.resolve({
          endpoint: ENDPOINT,
          send: () => Promise.reject(new Error('sem resposta')),
        }),
    })

    const result = await launchCommand({}, captured.deps)

    expect(dataOf(result).reused).toBe(false)
  })
})
