import type {
  AgentProvider,
  CapacitySnapshot,
  ProviderHealth,
  ProviderId,
  ProviderRegistry,
} from '@agentic/domain'
import { providerId as toProviderId } from '@agentic/domain'
import type { ProjectFile, ProviderConfig, ProvidersConfig } from '@agentic/schemas'
import type { CapacityLimits } from './capacity.js'
import { CapacityBook } from './capacity.js'
import { ClaudeCodeCliProvider } from './claude-code.js'
import { CodexCliProvider } from './codex.js'
import { describeUnknownError, UnknownProviderError } from './errors.js'
import type { LocalCliDescriptor, LocalCliProviderOptions, LocalCliRuntime } from './local-cli.js'
import { LocalCliAgentProvider } from './local-cli.js'
import type { MockScript } from './mock.js'
import { MockAgentProvider } from './mock.js'
import type { HealthCheckedAgentProvider } from './provider.js'

export interface ProviderFactoryInput {
  readonly id: ProviderId
  readonly config: ProviderConfig
  readonly capacity: CapacityBook
  readonly runtime: LocalCliRuntime | undefined
  readonly script: MockScript | undefined
  readonly now: (() => number) | undefined
}

export type ProviderFactory = (input: ProviderFactoryInput) => HealthCheckedAgentProvider

function cliOptions(input: ProviderFactoryInput): LocalCliProviderOptions {
  const options: LocalCliProviderOptions = {
    id: input.id,
    capacity: input.capacity,
    roles: input.config.roles,
  }
  return {
    ...options,
    ...(input.config.command === undefined ? {} : { command: input.config.command }),
    ...(input.config.versionArgs === undefined ? {} : { versionArgs: input.config.versionArgs }),
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    ...(input.now === undefined ? {} : { now: input.now }),
  }
}

function mockProvider(input: ProviderFactoryInput): HealthCheckedAgentProvider {
  return new MockAgentProvider({
    id: input.id,
    capacity: input.capacity,
    roles: input.config.roles,
    ...(input.script === undefined ? {} : { script: input.script }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}

/**
 * Descritor generico para uma CLI que o projeto declarou mas para a qual nao temos
 * adapter dedicado. `readinessProbe` sai de um fato — o projeto informou como perguntar
 * prontidao ou nao — e nunca de otimismo.
 */
export function descriptorFromConfig(id: string, config: ProviderConfig): LocalCliDescriptor {
  const readinessArgs = config.readinessArgs
  const supported = readinessArgs !== undefined && readinessArgs.length > 0
  const descriptor: LocalCliDescriptor = {
    id,
    command: config.command ?? id,
    capabilities: {
      roles: config.roles,
      streaming: true,
      cancellation: true,
      readinessProbe: supported ? 'supported' : 'unsupported',
      reportsUsage: false,
    },
    versionArgs: config.versionArgs ?? ['--version'],
    runArgs: [],
  }
  return supported ? { ...descriptor, readinessArgs } : descriptor
}

/**
 * Os nomes das CLIs vivem aqui e em `project.yaml`, em lugar nenhum mais (ADR-0010 3).
 * Id desconhecido cai no adapter generico — nao e erro configurar outra CLI local.
 */
export const BUILT_IN_PROVIDER_FACTORIES: Readonly<Record<string, ProviderFactory>> = {
  'claude-code': (input) => new ClaudeCodeCliProvider(cliOptions(input)),
  codex: (input) => new CodexCliProvider(cliOptions(input)),
  mock: mockProvider,
}

export function defaultProviderFactory(input: ProviderFactoryInput): HealthCheckedAgentProvider {
  const built = BUILT_IN_PROVIDER_FACTORIES[input.id]
  if (built !== undefined) return built(input)
  if (input.config.kind === 'inprocess') return mockProvider(input)
  return new LocalCliAgentProvider(descriptorFromConfig(input.id, input.config), cliOptions(input))
}

export interface ProviderRegistryOptions {
  readonly providers: ProvidersConfig
  /** Tetos globais e por papel; sem eles, o teto vira a soma das capacidades. */
  readonly limits?: Partial<CapacityLimits>
  readonly runtime?: LocalCliRuntime
  /** Roteiros dos providers in-process, por id. */
  readonly scripts?: Readonly<Record<string, MockScript>>
  readonly factories?: Readonly<Record<string, ProviderFactory>>
  readonly now?: () => number
}

/**
 * Registry construido a partir de `providers.registry` do project.yaml. Guarda a
 * contabilidade de vagas (I9) e agrega saude — sempre honesta, nunca lancando.
 */
export class DefaultProviderRegistry implements ProviderRegistry {
  readonly #providers = new Map<string, HealthCheckedAgentProvider>()
  readonly #capacity: CapacityBook
  readonly #default: ProviderId
  readonly #now: () => number

  constructor(options: ProviderRegistryOptions) {
    const entries = Object.entries(options.providers.registry)
    const limits: Record<string, number> = {}
    for (const [id, config] of entries) limits[id] = config.maxConcurrent
    this.#capacity = new CapacityBook(limits, options.limits ?? {})
    this.#default = toProviderId(options.providers.default)
    this.#now = options.now ?? Date.now

    for (const [id, config] of entries) {
      const providerId = toProviderId(id)
      const input: ProviderFactoryInput = {
        id: providerId,
        config,
        capacity: this.#capacity,
        runtime: options.runtime,
        script: options.scripts?.[id],
        now: options.now,
      }
      const factory = options.factories?.[id] ?? defaultProviderFactory
      this.#providers.set(id, factory(input))
    }
  }

  get defaultProviderId(): ProviderId {
    return this.#default
  }

  get capacityBook(): CapacityBook {
    return this.#capacity
  }

  get(id: ProviderId): AgentProvider {
    const provider = this.#providers.get(id)
    if (provider === undefined) throw new UnknownProviderError(id, this.list())
    return provider
  }

  /** Ordem alfabetica: retrato estavel, sem depender da ordem do YAML. */
  list(): ProviderId[] {
    return [...this.#providers.keys()].sort().map((id) => toProviderId(id))
  }

  /** Nunca lanca: sonda que falha vira entrada `unknown`, nao excecao (ADR-0010 4). */
  async health(): Promise<ProviderHealth[]> {
    const ids = this.list()
    return Promise.all(ids.map((id) => this.#healthOf(id)))
  }

  capacity(): CapacitySnapshot {
    return this.#capacity.snapshot()
  }

  async #healthOf(id: ProviderId): Promise<ProviderHealth> {
    const provider = this.#providers.get(id)
    const usage = this.#capacity.usage(id)
    if (provider === undefined) {
      return this.#unknownHealth(id, 'provider ausente do registry', usage.running, usage.capacity)
    }
    try {
      return await provider.health()
    } catch (error) {
      return this.#unknownHealth(
        id,
        `sonda falhou: ${describeUnknownError(error)}`,
        usage.running,
        usage.capacity,
      )
    }
  }

  #unknownHealth(
    id: ProviderId,
    detail: string,
    running: number,
    capacity: number | null,
  ): ProviderHealth {
    return {
      providerId: id,
      installed: 'unknown',
      ready: 'unknown',
      version: 'unknown',
      detail,
      probedAt: new Date(this.#now()),
      running,
      capacity,
    }
  }
}

export function createProviderRegistry(options: ProviderRegistryOptions): DefaultProviderRegistry {
  return new DefaultProviderRegistry(options)
}

/** Atalho para o caminho real: o project.yaml ja validado traz providers e tetos juntos. */
export function createProviderRegistryFromProject(
  project: ProjectFile,
  options: Omit<ProviderRegistryOptions, 'providers' | 'limits'> = {},
): DefaultProviderRegistry {
  return new DefaultProviderRegistry({
    ...options,
    providers: project.providers,
    limits: {
      maxParallelTasks: project.execution.maxParallelTasks,
      maxExecutors: project.execution.maxExecutors,
      maxReviewers: project.execution.maxReviewers,
    },
  })
}
