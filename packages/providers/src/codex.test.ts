import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import type { LocalAgentRuntimeDeps } from '@agentic/agent-runtime'
import { createLocalAgentRuntime, isAgentRuntimeError } from '@agentic/agent-runtime'
import { consumesAttempt } from '@agentic/domain'
import { afterAll, describe, expect, it } from 'vitest'
import { dispatchContext, executeAssignment } from './__fixtures__/assignments.js'
import type { FakeCliBundle } from './__fixtures__/fake-cli.js'
import {
  ARGV_FILE,
  ENV_FILE,
  FAKE_VERSION,
  makeFakeCliBundle,
  makeTempDir,
  PROMPT_FILE,
} from './__fixtures__/fake-cli.js'
import {
  CODEX_DESCRIPTOR,
  CODEX_READINESS_ARGS,
  CODEX_RUN_ARGS,
  CodexCliProvider,
} from './codex.js'
import { InvalidProviderDescriptorError } from './errors.js'
import { LocalCliAgentProvider } from './local-cli.js'

const cli: FakeCliBundle = makeFakeCliBundle()
const probeDir = makeTempDir('agentic-probe-')
const workspaces: string[] = []

const deps: LocalAgentRuntimeDeps = {
  platform: 'linux',
  probeCwd: probeDir,
  probeEnv: cli.env,
  probeTimeoutMs: 5_000,
  processDeps: { killGraceMs: 200, closeGraceMs: 300 },
}

function worktree(): string {
  const path = makeTempDir('agentic-codex-ws-')
  workspaces.push(path)
  return path
}

function provider(command: string, probeOnStart = true): CodexCliProvider {
  return new CodexCliProvider({
    command,
    runtime: createLocalAgentRuntime(deps),
    probeOnStart,
  })
}

afterAll(async () => {
  for (const path of workspaces) await rm(path, { recursive: true, force: true })
  await rm(probeDir, { recursive: true, force: true })
  cli.cleanup()
})

describe('CodexCliProvider — prontidao observavel', () => {
  it('declara readinessProbe supported com `login status`', () => {
    const capabilities = provider(cli.ok).capabilities()
    expect(capabilities.readinessProbe).toBe('supported')
    expect(CODEX_DESCRIPTOR.readinessArgs).toEqual(['login', 'status'])
    expect(CODEX_READINESS_ARGS).toEqual(['login', 'status'])
    expect(capabilities.roles).toEqual(['executor', 'reviewer'])
    expect(capabilities.streaming).toBe(true)
    expect(capabilities.cancellation).toBe(true)
    expect(capabilities.reportsUsage).toBe(false)
  })

  it('a spec enviada ao runtime carrega readinessArgs', () => {
    expect(provider(cli.ok).probeSpec().readinessArgs).toEqual(['login', 'status'])
  })

  it('`login status` saindo 0 reporta ready true', async () => {
    const health = await provider(cli.ok).health()
    expect(health.installed).toBe(true)
    expect(health.version).toBe(FAKE_VERSION)
    expect(health.ready).toBe(true)
  })

  it('`login status` saindo diferente de 0 reporta ready false', async () => {
    const health = await provider(cli.semLogin).health()
    expect(health.installed).toBe(true)
    expect(health.ready).toBe(false)
    expect(health.detail).toContain('prontidao false')
  })

  it('binario ausente reporta installed false', async () => {
    const health = await provider(cli.ausente).health()
    expect(health.installed).toBe(false)
    expect(health.ready).toBe(false)
  })
})

describe('CodexCliProvider — despacho', () => {
  it('sonda reprovando vira PROVIDER_NOT_READY e nao consome tentativa util', async () => {
    const path = worktree()
    const error = await provider(cli.semLogin)
      .start(executeAssignment(path), dispatchContext(path, { env: cli.env }))
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(isAgentRuntimeError(error)).toBe(true)
    if (!isAgentRuntimeError(error)) return
    expect(error.failureCode).toBe('PROVIDER_NOT_READY')
    expect(consumesAttempt(error.failureCode)).toBe(false)
  })

  it('CLI ausente vira PROVIDER_UNAVAILABLE, nao PROVIDER_NOT_READY', async () => {
    const path = worktree()
    const error = await provider(cli.ausente)
      .start(executeAssignment(path), dispatchContext(path, { env: cli.env }))
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(isAgentRuntimeError(error) && error.failureCode).toBe('PROVIDER_UNAVAILABLE')
  })

  it('com a sonda desligada, a prontidao so aparece no despacho', async () => {
    const path = worktree()
    const handle = await provider(cli.semLogin, false).start(
      executeAssignment(path),
      dispatchContext(path, { env: cli.env }),
    )
    expect((await handle.result()).status).toBe('completed')
  })

  it('executa `exec` com o assignment como ultimo argumento', async () => {
    const path = worktree()
    const handle = await provider(cli.ok).start(
      executeAssignment(path),
      dispatchContext(path, { env: cli.env }),
    )
    expect((await handle.result()).status).toBe('completed')
    const argv = (await readFile(join(path, ARGV_FILE), 'utf8')).split('\n').filter((l) => l !== '')
    expect(argv[0]).toBe(CODEX_RUN_ARGS[0])
    expect(await readFile(join(path, PROMPT_FILE), 'utf8')).toContain('## Contrato de validacao')
  })
})

describe('CodexCliProvider — subscription-first (P17/ADR-0009)', () => {
  it('nao repassa nenhuma variavel de credencial ao processo do agente', async () => {
    const path = worktree()
    nodeProcess.env.OPENAI_API_KEY = 'nao-pode-vazar'
    nodeProcess.env.ANTHROPIC_API_KEY = 'nao-pode-vazar'
    try {
      const handle = await provider(cli.ok).start(
        executeAssignment(path),
        dispatchContext(path, { env: { ...cli.env, PROJETO: 'desenvolvimento-agentico' } }),
      )
      await handle.result()
      const chaves = (await readFile(join(path, ENV_FILE), 'utf8'))
        .split('\n')
        .filter((linha) => linha.includes('='))
        .map((linha) => linha.slice(0, linha.indexOf('=')))
      expect(chaves).toContain('PROJETO')
      expect(chaves).not.toContain('OPENAI_API_KEY')
      expect(chaves).not.toContain('ANTHROPIC_API_KEY')
      expect(chaves.filter((c) => /KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD/i.test(c))).toEqual([])
    } finally {
      delete nodeProcess.env.OPENAI_API_KEY
      delete nodeProcess.env.ANTHROPIC_API_KEY
    }
  })
})

describe('LocalCliAgentProvider — descritor', () => {
  it('recusa declarar readinessProbe supported sem readinessArgs', () => {
    expect(
      () =>
        new LocalCliAgentProvider({
          id: 'cli-mentiroso',
          command: 'cli-mentiroso',
          capabilities: {
            roles: ['executor'],
            streaming: true,
            cancellation: true,
            readinessProbe: 'supported',
            reportsUsage: false,
          },
          versionArgs: ['--version'],
          runArgs: [],
        }),
    ).toThrow(InvalidProviderDescriptorError)
  })

  it('roles do project.yaml sobrescrevem os do descritor', () => {
    const restrito = new CodexCliProvider({ command: cli.ok, roles: ['reviewer'] })
    expect(restrito.capabilities().roles).toEqual(['reviewer'])
    expect(restrito.capabilities().readinessProbe).toBe('supported')
  })
})
