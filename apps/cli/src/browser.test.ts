import type { CapturedRun, RunSpec } from '@agentic/process'
import { describe, expect, it } from 'vitest'
import {
  BROWSER_ENV_ALLOW,
  browserCommandOf,
  headlessReason,
  openBrowser,
  type ProcessRunner,
} from './browser.js'

const URL = 'http://127.0.0.1:4317'
const GUI = { DISPLAY: ':0', PATH: '/usr/bin' }

function captured(partial: Partial<CapturedRun> = {}): CapturedRun {
  return {
    code: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    durationMs: 3,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutDigest: '',
    stderrDigest: '',
    ...partial,
  }
}

interface Runner {
  readonly run: ProcessRunner
  readonly specs: RunSpec[]
}

/** Executor de mentira: nenhum navegador de verdade abre durante a suite. */
function runner(result: CapturedRun = captured()): Runner {
  const specs: RunSpec[] = []
  return {
    specs,
    run: (spec) => {
      specs.push(spec)
      return Promise.resolve(result)
    },
  }
}

describe('comando de abertura por plataforma', () => {
  it('macOS usa `open`', () => {
    expect(browserCommandOf('darwin', URL)).toEqual({ command: 'open', args: [URL] })
  })

  it('Windows usa `cmd /c start` com o titulo vazio no lugar certo', () => {
    // Sem o "" a URL vira titulo da janela e nada abre.
    expect(browserCommandOf('win32', URL)).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', URL],
    })
  })

  it('o resto do mundo POSIX usa `xdg-open`', () => {
    expect(browserCommandOf('linux', URL)).toEqual({ command: 'xdg-open', args: [URL] })
    expect(browserCommandOf('freebsd', URL)).toEqual({ command: 'xdg-open', args: [URL] })
  })

  it('plataforma nao declarada nao tem comando: `unknown` nao vira tentativa', () => {
    expect(browserCommandOf(undefined, URL)).toBeUndefined()
  })
})

describe('deteccao de ambiente sem GUI', () => {
  it('Linux com DISPLAY tem ambiente grafico', () => {
    expect(headlessReason({ platform: 'linux', env: { DISPLAY: ':0' } })).toBeUndefined()
  })

  it('Linux com WAYLAND_DISPLAY tambem tem', () => {
    expect(
      headlessReason({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }),
    ).toBeUndefined()
  })

  it('Linux sem DISPLAY nem WAYLAND_DISPLAY nao tem', () => {
    expect(headlessReason({ platform: 'linux', env: {} })).toContain('DISPLAY')
  })

  it('CI nunca abre navegador, mesmo com DISPLAY', () => {
    expect(headlessReason({ platform: 'linux', env: { ...GUI, CI: 'true' } })).toContain('CI')
  })

  it('`CI=false` nao e CI: variavel desligada nao desliga a jornada', () => {
    expect(headlessReason({ platform: 'linux', env: { ...GUI, CI: 'false' } })).toBeUndefined()
  })

  it('sessao SSH sem DISPLAY encaminhado nao abre navegador no servidor', () => {
    expect(
      headlessReason({ platform: 'darwin', env: { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' } }),
    ).toContain('SSH')
  })

  it('sessao SSH COM DISPLAY encaminhado abre', () => {
    expect(
      headlessReason({ platform: 'linux', env: { ...GUI, SSH_TTY: '/dev/pts/1' } }),
    ).toBeUndefined()
  })

  it('macOS e Windows locais nao dependem de DISPLAY', () => {
    expect(headlessReason({ platform: 'darwin', env: {} })).toBeUndefined()
    expect(headlessReason({ platform: 'win32', env: {} })).toBeUndefined()
  })

  it('plataforma nao declarada conta como sem GUI', () => {
    expect(headlessReason({ platform: undefined, env: GUI })).toContain('plataforma')
  })
})

describe('abertura do navegador', () => {
  it('despacha o comando da plataforma com a URL e relata o que rodou', async () => {
    const fake = runner()
    const outcome = await openBrowser(
      { url: URL, cwd: '/projeto', platform: 'linux', env: GUI },
      fake.run,
    )

    expect(outcome.opened).toBe(true)
    expect(outcome.command).toBe(`xdg-open ${URL}`)
    expect(fake.specs).toHaveLength(1)
    expect(fake.specs[0]?.command).toBe('xdg-open')
    expect(fake.specs[0]?.args).toEqual([URL])
    expect(fake.specs[0]?.cwd).toBe('/projeto')
  })

  it('sem ambiente grafico NAO dispara processo nenhum e explica o motivo', async () => {
    const fake = runner()
    const outcome = await openBrowser(
      { url: URL, cwd: '/projeto', platform: 'linux', env: { PATH: '/usr/bin' } },
      fake.run,
    )

    expect(outcome.opened).toBe(false)
    expect(outcome.reason).toContain('DISPLAY')
    // "nao tenta abrir" e literal: nada foi executado.
    expect(fake.specs).toHaveLength(0)
  })

  it('o ambiente do filho e allowlist: segredo do shell nao vaza para o navegador', async () => {
    const fake = runner()
    await openBrowser(
      {
        url: URL,
        cwd: '/projeto',
        platform: 'linux',
        env: { ...GUI, AWS_SECRET_ACCESS_KEY: 'nao-pode-vazar', ANTHROPIC_API_KEY: 'nem-esta' },
      },
      fake.run,
    )

    const env = fake.specs[0]?.env ?? {}
    expect(Object.keys(env).sort()).toEqual(['DISPLAY', 'PATH'])
    expect(Object.keys(env).every((key) => BROWSER_ENV_ALLOW.includes(key))).toBe(true)
    expect(JSON.stringify(env)).not.toContain('nao-pode-vazar')
  })

  it('abridor ausente vira motivo legivel, nunca excecao', async () => {
    const fake = runner(
      captured({ code: null, spawnError: { code: 'ENOENT', message: 'spawn xdg-open ENOENT' } }),
    )
    const outcome = await openBrowser(
      { url: URL, cwd: '/projeto', platform: 'linux', env: GUI },
      fake.run,
    )

    expect(outcome.opened).toBe(false)
    expect(outcome.reason).toContain('ENOENT')
  })

  it('abridor que falha reporta o que ele mesmo disse', async () => {
    const fake = runner(captured({ code: 3, stderr: 'no method available for opening\n' }))
    const outcome = await openBrowser(
      { url: URL, cwd: '/projeto', platform: 'linux', env: GUI },
      fake.run,
    )

    expect(outcome.opened).toBe(false)
    expect(outcome.reason).toContain('no method available')
  })

  it('falha sem diagnostico ainda diz o codigo de saida', async () => {
    const fake = runner(captured({ code: 4 }))
    const outcome = await openBrowser(
      { url: URL, cwd: '/projeto', platform: 'darwin', env: {} },
      fake.run,
    )

    expect(outcome.opened).toBe(false)
    expect(outcome.reason).toContain('4')
  })

  it('nao ha timeout: o timeout mataria a arvore, e a arvore e o navegador do usuario', async () => {
    const fake = runner()
    await openBrowser({ url: URL, cwd: '/projeto', platform: 'linux', env: GUI }, fake.run)

    expect(fake.specs[0]?.timeoutMs).toBeUndefined()
  })
})
