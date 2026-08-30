import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import type { LocalAgentRuntimeDeps } from '@agentic/agent-runtime'
import { createLocalAgentRuntime, isAgentRuntimeError } from '@agentic/agent-runtime'
import { consumesAttempt } from '@agentic/domain'
import type { ProviderConfig } from '@agentic/schemas'
import { afterAll, describe, expect, it } from 'vitest'
import { dispatchContext, executeAssignment, reviewAssignment } from './__fixtures__/assignments.js'
import type { FakeCliBundle } from './__fixtures__/fake-cli.js'
import {
  ARGV_FILE,
  ENV_FILE,
  FAKE_VERSION,
  makeFakeCliBundle,
  makeTempDir,
  PROMPT_FILE,
} from './__fixtures__/fake-cli.js'
import { CLAUDE_CODE_RUN_ARGS, ClaudeCodeCliProvider } from './claude-code.js'
import { createProviderRegistry } from './registry.js'

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

function runtime(): ReturnType<typeof createLocalAgentRuntime> {
  return createLocalAgentRuntime(deps)
}

function worktree(): string {
  const path = makeTempDir('agentic-claude-ws-')
  workspaces.push(path)
  return path
}

function provider(command: string): ClaudeCodeCliProvider {
  return new ClaudeCodeCliProvider({ command, runtime: runtime() })
}

afterAll(async () => {
  for (const path of workspaces) await rm(path, { recursive: true, force: true })
  await rm(probeDir, { recursive: true, force: true })
  cli.cleanup()
})

describe('ClaudeCodeCliProvider — honestidade de prontidao (ADR-0010 4)', () => {
  it('CLI que responde --version reporta installed true e ready UNKNOWN', async () => {
    const health = await provider(cli.ok).health()
    expect(health.installed).toBe(true)
    expect(health.version).toBe(FAKE_VERSION)
    expect(health.ready).toBe('unknown')
  })

  it('nao ha caminho para ready true: nem com um binario cujo `login status` sai 0', async () => {
    // O mesmo executavel responde `login status` com exit 0. O adapter nao pergunta.
    const health = await provider(cli.ok).health()
    expect(health.ready).not.toBe(true)
    expect(health.ready).toBe('unknown')
    expect(health.detail).toContain('readinessProbe unsupported')
  })

  it('nao ha caminho para ready true: nem quando o project.yaml declara readinessArgs', async () => {
    const config: ProviderConfig = {
      kind: 'local-cli',
      command: cli.ok,
      versionArgs: ['--version'],
      readinessArgs: ['login', 'status'],
      maxConcurrent: 1,
      roles: ['executor', 'reviewer'],
    }
    const registry = createProviderRegistry({
      providers: { default: 'claude-code', registry: { 'claude-code': config } },
      runtime: runtime(),
    })
    const [health] = await registry.health()
    expect(health?.installed).toBe(true)
    expect(health?.ready).toBe('unknown')
  })

  it('capabilities declara readinessProbe unsupported, imutavel', () => {
    const capabilities = provider(cli.ok).capabilities()
    expect(capabilities.readinessProbe).toBe('unsupported')
    expect(capabilities.roles).toEqual(['executor', 'reviewer'])
    expect(capabilities.streaming).toBe(true)
    expect(capabilities.cancellation).toBe(true)
    expect(capabilities.reportsUsage).toBe(false)
  })

  it('a spec enviada ao runtime nao carrega readinessArgs', () => {
    expect(provider(cli.ok).probeSpec().readinessArgs).toBeUndefined()
  })

  it('versao ilegivel vira unknown sem inventar prontidao', async () => {
    const health = await provider(cli.mudo).health()
    expect(health.installed).toBe(true)
    expect(health.version).toBe('unknown')
    expect(health.ready).toBe('unknown')
  })

  it('binario ausente reporta installed false e ready false, por ausencia', async () => {
    const health = await provider(cli.ausente).health()
    expect(health.installed).toBe(false)
    expect(health.ready).toBe(false)
  })
})

describe('ClaudeCodeCliProvider — execucao headless', () => {
  it('monta o modo nao interativo com o assignment como ultimo argumento', async () => {
    const path = worktree()
    const handle = await provider(cli.ok).start(
      executeAssignment(path),
      dispatchContext(path, { env: cli.env }),
    )
    expect((await handle.result()).status).toBe('completed')
    const argv = (await readFile(join(path, ARGV_FILE), 'utf8')).split('\n').filter((l) => l !== '')
    expect(argv.slice(0, CLAUDE_CODE_RUN_ARGS.length)).toEqual([...CLAUDE_CODE_RUN_ARGS])
    const prompt = await readFile(join(path, PROMPT_FILE), 'utf8')
    expect(prompt).toContain('## Objetivo')
    expect(prompt).toContain('packages/providers/')
  })

  it('o prompt de revisao leva diff e gate, e nao a narrativa do executor (P07)', async () => {
    const path = worktree()
    const handle = await provider(cli.ok).start(
      reviewAssignment(path),
      dispatchContext(path, { env: cli.env }),
    )
    await handle.result()
    const prompt = await readFile(join(path, PROMPT_FILE), 'utf8')
    expect(prompt).toContain('## Diff observado')
    expect(prompt).toContain('diff:sha256-abc123')
    expect(prompt).toContain('## Resultados de gate')
    expect(prompt).not.toContain('claims')
  })

  it('CLI ausente vira PROVIDER_UNAVAILABLE e nao consome tentativa util', async () => {
    const path = worktree()
    const error = await provider(cli.ausente)
      .start(executeAssignment(path), dispatchContext(path, { env: cli.env }))
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(isAgentRuntimeError(error)).toBe(true)
    if (!isAgentRuntimeError(error)) return
    expect(error.failureCode).toBe('PROVIDER_UNAVAILABLE')
    expect(consumesAttempt(error.failureCode)).toBe(false)
  })

  it('sessao sem login nao vira PROVIDER_NOT_READY: a CLI nao permite observar', async () => {
    const path = worktree()
    const handle = await provider(cli.semLogin).start(
      executeAssignment(path),
      dispatchContext(path, { env: cli.env }),
    )
    expect((await handle.result()).status).toBe('completed')
  })
})

describe('ClaudeCodeCliProvider — subscription-first (P17/ADR-0009)', () => {
  it('nao repassa nenhuma variavel de credencial ao processo do agente', async () => {
    const path = worktree()
    nodeProcess.env.ANTHROPIC_API_KEY = 'nao-pode-vazar'
    nodeProcess.env.OPENAI_API_KEY = 'nao-pode-vazar'
    nodeProcess.env.AGENTIC_TOKEN_SECRETO = 'nao-pode-vazar'
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
      expect(chaves).not.toContain('ANTHROPIC_API_KEY')
      expect(chaves).not.toContain('OPENAI_API_KEY')
      expect(chaves).not.toContain('AGENTIC_TOKEN_SECRETO')
      expect(chaves.filter((c) => /KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD/i.test(c))).toEqual([])
    } finally {
      delete nodeProcess.env.ANTHROPIC_API_KEY
      delete nodeProcess.env.OPENAI_API_KEY
      delete nodeProcess.env.AGENTIC_TOKEN_SECRETO
    }
  })

  it('o adapter nao exige nenhuma variavel de credencial para funcionar', async () => {
    const path = worktree()
    const handle = await provider(cli.ok).start(
      executeAssignment(path),
      dispatchContext(path, { env: cli.env }),
    )
    expect((await handle.result()).status).toBe('completed')
  })
})
