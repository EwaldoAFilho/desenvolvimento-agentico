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
  PII_EMAIL,
  PII_ORG,
  PII_ORG_ID,
  PII_TOKEN,
  PROMPT_FILE,
} from './__fixtures__/fake-cli.js'
import {
  CLAUDE_CODE_DESCRIPTOR,
  CLAUDE_CODE_READINESS_ARGS,
  CLAUDE_CODE_RUN_ARGS,
  ClaudeCodeCliProvider,
} from './claude-code.js'
import { LocalCliAgentProvider } from './local-cli.js'
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

function runtime(
  extra: Partial<LocalAgentRuntimeDeps> = {},
): ReturnType<typeof createLocalAgentRuntime> {
  return createLocalAgentRuntime({ ...deps, ...extra })
}

function worktree(): string {
  const path = makeTempDir('agentic-claude-ws-')
  workspaces.push(path)
  return path
}

function provider(
  command: string,
  extra: Partial<LocalAgentRuntimeDeps> = {},
): ClaudeCodeCliProvider {
  return new ClaudeCodeCliProvider({ command, runtime: runtime(extra) })
}

afterAll(async () => {
  for (const path of workspaces) await rm(path, { recursive: true, force: true })
  await rm(probeDir, { recursive: true, force: true })
  cli.cleanup()
})

describe('ClaudeCodeCliProvider — prontidao observavel (ADR-0010 4)', () => {
  it('declara readinessProbe supported com a sonda `auth status`', () => {
    const capabilities = provider(cli.ok).capabilities()
    expect(capabilities.readinessProbe).toBe('supported')
    expect(CLAUDE_CODE_READINESS_ARGS).toEqual(['auth', 'status'])
    expect(CLAUDE_CODE_DESCRIPTOR.readinessArgs).toEqual(['auth', 'status'])
    expect(capabilities.roles).toEqual(['executor', 'reviewer'])
    expect(capabilities.streaming).toBe(true)
    expect(capabilities.cancellation).toBe(true)
    expect(capabilities.reportsUsage).toBe(false)
  })

  it('a spec enviada ao runtime carrega readinessArgs', () => {
    expect(provider(cli.ok).probeSpec().readinessArgs).toEqual(['auth', 'status'])
  })

  it('sonda saindo 0 reporta ready true e readinessSource citando a sonda', async () => {
    const health = await provider(cli.ok).health()
    expect(health.installed).toBe(true)
    expect(health.version).toBe(FAKE_VERSION)
    expect(health.ready).toBe(true)
    expect(health.readinessSource).toContain('auth status')
    expect(health.readinessSource).toContain('saiu 0')
  })

  it('CONTROLE de honestidade: --version responde mas a sonda falha -> ready FALSE', async () => {
    // `--version` prova instalacao e nada mais. Sem sonda aprovada nao ha ready true.
    const health = await provider(cli.semLogin).health()
    expect(health.installed).toBe(true)
    expect(health.version).toBe(FAKE_VERSION)
    expect(health.ready).toBe(false)
    expect(health.ready).not.toBe(true)
    expect(health.readinessSource).toContain('codigo 1')
  })

  it('sonda que trava mantem ready unknown — travar nao e prova de nao-prontidao', async () => {
    const health = await provider(cli.sondaLenta, { probeTimeoutMs: 300 }).health()
    expect(health.installed).toBe(true)
    expect(health.ready).toBe('unknown')
    expect(health.readinessSource).toContain('expirou')
    expect(health.diagnostic?.kind).toBe('probe-failed')
  })

  it('sonda ausente na capacidade declarada mantem ready unknown, nunca true', async () => {
    const semSonda = new LocalCliAgentProvider(
      {
        ...CLAUDE_CODE_DESCRIPTOR,
        capabilities: { ...CLAUDE_CODE_DESCRIPTOR.capabilities, readinessProbe: 'unsupported' },
      },
      { command: cli.ok, runtime: runtime() },
    )
    const health = await semSonda.health()
    expect(semSonda.probeSpec().readinessArgs).toBeUndefined()
    expect(health.installed).toBe(true)
    expect(health.ready).toBe('unknown')
    expect(health.ready).not.toBe(true)
    expect(health.readinessSource).toContain('nao expoe estado de autenticacao')
  })

  it('versao ilegivel vira unknown sem contaminar a prontidao observada', async () => {
    const health = await provider(cli.mudo).health()
    expect(health.installed).toBe(true)
    expect(health.version).toBe('unknown')
    expect(health.ready).toBe(true)
  })

  it('a sonda do adapter dedicado nao vem do project.yaml', async () => {
    const config: ProviderConfig = {
      kind: 'local-cli',
      command: cli.ok,
      versionArgs: ['--version'],
      readinessArgs: ['inventado', 'pelo', 'yaml'],
      maxConcurrent: 1,
      roles: ['executor', 'reviewer'],
    }
    const registry = createProviderRegistry({
      providers: { default: 'claude-code', registry: { 'claude-code': config } },
      runtime: runtime(),
    })
    const [health] = await registry.health()
    expect(health?.installed).toBe(true)
    expect(health?.ready).toBe(true)
    expect(health?.readinessSource).toContain('auth status')
  })
})

describe('ClaudeCodeCliProvider — prontidao com caminho e diagnostico', () => {
  it('resolvedPath traz o caminho absoluto do executavel encontrado', async () => {
    const health = await provider(cli.ok).health()
    expect(health.resolvedPath).toBe(cli.ok)
    expect(health.diagnostic).toBeUndefined()
  })

  it('resolvedPath fica unknown quando o executavel nao resolve', async () => {
    const health = await provider(cli.ausente).health()
    expect(health.resolvedPath).toBe('unknown')
    expect(health.installed).toBe(false)
    expect(health.ready).toBe(false)
    expect(health.diagnostic?.kind).toBe('not-found')
  })

  it('symlink quebrado vira diagnostico broken-symlink com alvo e remediacao', async () => {
    const health = await provider(cli.quebrado).health()
    expect(health.installed).toBe(false)
    expect(health.resolvedPath).toBe('unknown')
    expect(health.diagnostic?.kind).toBe('broken-symlink')
    expect(health.diagnostic?.target).toBe(cli.quebradoAlvo)
    expect(health.diagnostic?.detail).toContain(cli.quebrado)
    expect(health.diagnostic?.remediation ?? '').not.toHaveLength(0)
    expect(health.detail).toContain('symlink quebrado')
  })

  it('symlink quebrado no despacho continua PROVIDER_UNAVAILABLE', async () => {
    const path = worktree()
    const error = await provider(cli.quebrado)
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

  it('readinessSource e preenchido em toda resposta, inclusive nas unknown', async () => {
    const casos = await Promise.all([
      provider(cli.ok).health(),
      provider(cli.semLogin).health(),
      provider(cli.ausente).health(),
      provider(cli.quebrado).health(),
      provider(cli.sondaLenta, { probeTimeoutMs: 300 }).health(),
    ])
    for (const health of casos) {
      expect(typeof health.readinessSource).toBe('string')
      expect(health.readinessSource ?? '').not.toHaveLength(0)
    }
  })
})

describe('ClaudeCodeCliProvider — dado pessoal na saida da sonda', () => {
  it('e-mail, organizacao e token da sonda nao aparecem em detail nem readinessSource', async () => {
    const health = await provider(cli.pii).health()
    expect(health.ready).toBe(true)
    for (const vazamento of [PII_EMAIL, PII_ORG, PII_ORG_ID, PII_TOKEN]) {
      expect(health.detail).not.toContain(vazamento)
      expect(health.readinessSource ?? '').not.toContain(vazamento)
    }
  })

  it('o health serializado inteiro nao carrega e-mail nem token', async () => {
    const serializado = JSON.stringify(await provider(cli.pii).health())
    expect(serializado).not.toContain(PII_EMAIL)
    expect(serializado).not.toContain(PII_ORG)
    expect(serializado).not.toContain(PII_ORG_ID)
    expect(serializado).not.toContain(PII_TOKEN)
    expect(serializado).not.toContain('@exemplo.com')
  })

  it('do JSON da sonda so o sinal booleano e lido', async () => {
    const health = await provider(cli.pii).health()
    expect(health.ready).toBe(true)
    expect(health.readinessSource).toContain('sessao autenticada')
    expect(health.readinessSource).not.toContain('loggedIn')
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

  it('sessao sem login agora vira PROVIDER_NOT_READY e nao consome tentativa util', async () => {
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

  it('prontidao unknown nao recusa despacho: a verdade aparece no processo', async () => {
    const path = worktree()
    const semSonda = new LocalCliAgentProvider(
      {
        ...CLAUDE_CODE_DESCRIPTOR,
        capabilities: { ...CLAUDE_CODE_DESCRIPTOR.capabilities, readinessProbe: 'unsupported' },
      },
      { command: cli.semLogin, runtime: runtime() },
    )
    const handle = await semSonda.start(
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
