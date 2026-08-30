import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { LocalAgentSpec, ProviderHealth } from '@agentic/domain'
import { providerId } from '@agentic/domain'
import type { ProviderConfig, ProvidersConfig } from '@agentic/schemas'
import { parseProjectFile } from '@agentic/schemas'
import { afterAll, describe, expect, it } from 'vitest'
import { dispatchContext, executeAssignment } from './__fixtures__/assignments.js'
import { makeTempDir } from './__fixtures__/fake-cli.js'
import { ClaudeCodeCliProvider } from './claude-code.js'
import { CodexCliProvider } from './codex.js'
import { ProviderAtCapacityError, UnknownProviderError } from './errors.js'
import type { LocalCliRuntime } from './local-cli.js'
import { LocalCliAgentProvider } from './local-cli.js'
import { MockAgentProvider } from './mock.js'
import {
  createProviderRegistry,
  createProviderRegistryFromProject,
  descriptorFromConfig,
} from './registry.js'

/** project.yaml real do repositorio: o registry precisa nascer do arquivo, nao de fixture. */
const PROJECT_YAML = new URL('../../../.agentic/project.yaml', import.meta.url)
const parsed = parseProjectFile(readFileSync(PROJECT_YAML, 'utf8'))
if (!parsed.ok) throw new Error(`project.yaml invalido: ${JSON.stringify(parsed.issues)}`)
const project = parsed.value

/** Nenhum processo real: a sonda e um duble e o spawn e proibido neste arquivo. */
const stubRuntime: LocalCliRuntime = {
  probe: (spec: LocalAgentSpec): Promise<ProviderHealth> =>
    Promise.resolve({
      providerId: spec.providerId,
      installed: true,
      ready: 'unknown',
      version: '9.9.9',
      detail: 'sonda de teste',
      probedAt: new Date('2026-01-01T00:00:00.000Z'),
      running: 0,
      capacity: null,
    }),
  spawn: () => Promise.reject(new Error('o teste do registry nunca inicia processo')),
}

const workspaces: string[] = []

function worktree(): string {
  const path = makeTempDir('agentic-registry-ws-')
  workspaces.push(path)
  return path
}

afterAll(async () => {
  for (const path of workspaces) await rm(path, { recursive: true, force: true })
})

function inprocess(maxConcurrent: number): ProviderConfig {
  return { kind: 'inprocess', maxConcurrent, roles: ['executor', 'reviewer'] }
}

function providersConfig(registry: Record<string, ProviderConfig>): ProvidersConfig {
  const first = Object.keys(registry)[0] ?? 'mock'
  return { default: first, registry }
}

describe('ProviderRegistry — construido do project.yaml real', () => {
  it('registra os tres providers declarados', () => {
    const registry = createProviderRegistryFromProject(project, { runtime: stubRuntime })
    expect(registry.list()).toEqual(['claude-code', 'codex', 'mock'])
    expect(registry.defaultProviderId).toBe('claude-code')
  })

  it('respeita o maxConcurrent de cada fornecedor: claude-code 3 e codex 2', () => {
    const registry = createProviderRegistryFromProject(project, { runtime: stubRuntime })
    const snapshot = registry.capacity()
    expect(snapshot.byProvider['claude-code']?.maxConcurrent).toBe(3)
    expect(snapshot.byProvider.codex?.maxConcurrent).toBe(2)
    expect(snapshot.byProvider.mock?.maxConcurrent).toBe(8)
    expect(snapshot.byProvider['claude-code']?.running).toBe(0)
  })

  it('herda os tetos globais de execution', () => {
    const registry = createProviderRegistryFromProject(project, { runtime: stubRuntime })
    const snapshot = registry.capacity()
    expect(snapshot.global.maxParallelTasks).toBe(project.execution.maxParallelTasks)
    expect(snapshot.executor.max).toBe(project.execution.maxExecutors)
    expect(snapshot.reviewer.max).toBe(project.execution.maxReviewers)
    expect(snapshot.global.active).toBe(0)
  })

  it('escolhe o adapter certo para cada id declarado', () => {
    const registry = createProviderRegistryFromProject(project, { runtime: stubRuntime })
    expect(registry.get(providerId('claude-code'))).toBeInstanceOf(ClaudeCodeCliProvider)
    expect(registry.get(providerId('codex'))).toBeInstanceOf(CodexCliProvider)
    expect(registry.get(providerId('mock'))).toBeInstanceOf(MockAgentProvider)
  })

  it('cada adapter real declara a sonda de prontidao que a sua CLI permite', () => {
    const registry = createProviderRegistryFromProject(project, { runtime: stubRuntime })
    expect(registry.get(providerId('claude-code')).capabilities().readinessProbe).toBe(
      'unsupported',
    )
    expect(registry.get(providerId('codex')).capabilities().readinessProbe).toBe('supported')
  })

  it('get de provider desconhecido falha com UnknownProviderError', () => {
    const registry = createProviderRegistryFromProject(project, { runtime: stubRuntime })
    expect(() => registry.get(providerId('inexistente'))).toThrow(UnknownProviderError)
  })

  it('health agrega um retrato por provider, na mesma ordem de list()', async () => {
    const registry = createProviderRegistryFromProject(project, { runtime: stubRuntime })
    const health = await registry.health()
    expect(health.map((entry) => entry.providerId)).toEqual(registry.list())
    expect(health.every((entry) => Number.isInteger(entry.running))).toBe(true)
  })
})

describe('ProviderRegistry — saude honesta', () => {
  it('nunca lanca: sonda que explode vira entrada unknown', async () => {
    const explosivo: LocalCliRuntime = {
      probe: () => Promise.reject(new Error('sonda explodiu')),
      spawn: () => Promise.reject(new Error('nao usado')),
    }
    const registry = createProviderRegistryFromProject(project, { runtime: explosivo })
    const health = await registry.health()
    const claude = health.find((entry) => entry.providerId === 'claude-code')
    expect(claude?.installed).toBe('unknown')
    expect(claude?.ready).toBe('unknown')
    expect(claude?.version).toBe('unknown')
    expect(claude?.detail).toContain('sonda explodiu')
  })

  it('reporta running e capacity mesmo quando a sonda falha', async () => {
    const explosivo: LocalCliRuntime = {
      probe: () => Promise.reject(new Error('sonda explodiu')),
      spawn: () => Promise.reject(new Error('nao usado')),
    }
    const registry = createProviderRegistryFromProject(project, { runtime: explosivo })
    const health = await registry.health()
    const codex = health.find((entry) => entry.providerId === 'codex')
    expect(codex?.capacity).toBe(2)
    expect(codex?.running).toBe(0)
  })
})

describe('ProviderRegistry — capacidade compartilhada (I9)', () => {
  it('recusa despacho alem do maxConcurrent do provider', async () => {
    const path = worktree()
    const registry = createProviderRegistry({
      providers: providersConfig({ mock: inprocess(2) }),
      scripts: {
        mock: {
          default: { status: 'completed', claims: { summary: 'lento' }, delayMs: 30_000 },
        },
      },
    })
    const provider = registry.get(providerId('mock'))
    const primeiro = await provider.start(executeAssignment(path), dispatchContext(path))
    const segundo = await provider.start(executeAssignment(path), dispatchContext(path))
    expect(registry.capacity().byProvider.mock?.running).toBe(2)

    const erro = await provider.start(executeAssignment(path), dispatchContext(path)).then(
      () => null,
      (e: unknown) => e,
    )
    expect(erro).toBeInstanceOf(ProviderAtCapacityError)
    if (erro instanceof ProviderAtCapacityError) {
      expect(erro.reason).toBe('AT_CAPACITY')
      expect(erro.capacity).toBe(2)
    }

    await primeiro.cancel('libera')
    await primeiro.result()
    expect(registry.capacity().byProvider.mock?.running).toBe(1)
    const terceiro = await provider.start(executeAssignment(path), dispatchContext(path))
    await Promise.all([segundo.cancel('fim'), terceiro.cancel('fim')])
    await Promise.all([segundo.result(), terceiro.result()])
    expect(registry.capacity().global.active).toBe(0)
  })

  it('capacidade de um provider e compartilhada entre execucao e revisao', async () => {
    const path = worktree()
    const registry = createProviderRegistry({
      providers: providersConfig({ mock: inprocess(1) }),
      scripts: {
        mock: {
          default: { status: 'completed', claims: { summary: 'lento' }, delayMs: 30_000 },
        },
      },
    })
    const provider = registry.get(providerId('mock'))
    const executando = await provider.start(executeAssignment(path), dispatchContext(path))
    expect(registry.capacity().executor.active).toBe(1)
    const erro = await provider.start({ ...executeAssignment(path) }, dispatchContext(path)).then(
      () => null,
      (e: unknown) => e,
    )
    expect(erro).toBeInstanceOf(ProviderAtCapacityError)
    await executando.cancel('fim')
    await executando.result()
  })
})

describe('ProviderRegistry — CLI local sem adapter dedicado', () => {
  it('monta adapter generico e declara sonda a partir do que a config informa', () => {
    const comSonda: ProviderConfig = {
      kind: 'local-cli',
      command: 'outra-cli',
      readinessArgs: ['auth', 'whoami'],
      maxConcurrent: 1,
      roles: ['executor'],
    }
    const registry = createProviderRegistry({
      providers: providersConfig({ 'outra-cli': comSonda }),
      runtime: stubRuntime,
    })
    const provider = registry.get(providerId('outra-cli'))
    expect(provider).toBeInstanceOf(LocalCliAgentProvider)
    expect(provider.capabilities().readinessProbe).toBe('supported')
    expect(provider.capabilities().roles).toEqual(['executor'])
  })

  it('sem readinessArgs na config, a sonda e declarada como nao suportada', () => {
    const semSonda: ProviderConfig = {
      kind: 'local-cli',
      command: 'outra-cli',
      maxConcurrent: 1,
      roles: ['executor', 'reviewer'],
    }
    expect(descriptorFromConfig('outra-cli', semSonda).capabilities.readinessProbe).toBe(
      'unsupported',
    )
    expect(descriptorFromConfig('outra-cli', semSonda).versionArgs).toEqual(['--version'])
  })

  it('kind inprocess sem adapter dedicado tambem cai no mock', () => {
    const registry = createProviderRegistry({
      providers: providersConfig({ 'mock-secundario': inprocess(1) }),
    })
    expect(registry.get(providerId('mock-secundario'))).toBeInstanceOf(MockAgentProvider)
  })
})
