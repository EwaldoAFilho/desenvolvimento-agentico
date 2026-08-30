import type { CapacityAcquisition, CapacityRelease, CapacityUsage } from '@agentic/agent-runtime'
import { CapacityLedger } from '@agentic/agent-runtime'
import type { AgentRole, CapacitySnapshot, ProviderId } from '@agentic/domain'

/** Tetos globais e por papel. Vem de `execution` no project.yaml, nao do registry. */
export interface CapacityLimits {
  readonly maxParallelTasks: number
  readonly maxExecutors: number
  readonly maxReviewers: number
}

/**
 * O que um adapter precisa da contabilidade: pegar e devolver vaga. Interface estreita
 * de proposito — o provider nao tem por que enxergar o retrato global.
 */
export interface CapacityBookLike {
  acquire(providerId: ProviderId, slot: AgentRole): CapacityAcquisition
  release(providerId: ProviderId, slot: AgentRole): CapacityRelease
  usage(providerId: ProviderId): CapacityUsage
}

/**
 * `CapacityLedger` (por provider, I9) mais a contagem por papel que o `CapacitySnapshot`
 * exige. O papel vem do proprio Assignment (`kind`), entao o adapter sabe informar sem
 * que o dominio precise carregar essa distincao ate aqui.
 *
 * Enforcement e apenas por provider: os tetos global e por papel sao entrada do scheduler
 * (funcao pura), nao regra deste livro-caixa.
 */
export class CapacityBook implements CapacityBookLike {
  readonly #ledger: CapacityLedger
  readonly #limits: CapacityLimits
  readonly #bySlot: Record<AgentRole, number> = { executor: 0, reviewer: 0 }

  constructor(
    perProvider: Readonly<Record<string, number>> = {},
    limits: Partial<CapacityLimits> = {},
  ) {
    this.#ledger = new CapacityLedger(perProvider)
    const total = Object.values(perProvider).reduce((sum, max) => sum + Math.max(0, max), 0)
    this.#limits = {
      maxParallelTasks: limits.maxParallelTasks ?? total,
      maxExecutors: limits.maxExecutors ?? total,
      maxReviewers: limits.maxReviewers ?? total,
    }
  }

  get limits(): CapacityLimits {
    return this.#limits
  }

  acquire(providerId: ProviderId, slot: AgentRole): CapacityAcquisition {
    const result = this.#ledger.acquire(providerId)
    if (result.ok) this.#bySlot[slot] += 1
    return result
  }

  release(providerId: ProviderId, slot: AgentRole): CapacityRelease {
    const result = this.#ledger.release(providerId)
    if (result.ok) this.#bySlot[slot] = Math.max(0, this.#bySlot[slot] - 1)
    return result
  }

  usage(providerId: ProviderId): CapacityUsage {
    return this.#ledger.usage(providerId)
  }

  /** Retrato novo a cada chamada: mutar o resultado nao altera a conta. */
  snapshot(): CapacitySnapshot {
    const byProvider = this.#ledger.snapshot()
    const active = Object.values(byProvider).reduce((sum, entry) => sum + entry.running, 0)
    return {
      global: { maxParallelTasks: this.#limits.maxParallelTasks, active },
      executor: { max: this.#limits.maxExecutors, active: this.#bySlot.executor },
      reviewer: { max: this.#limits.maxReviewers, active: this.#bySlot.reviewer },
      byProvider,
    }
  }
}

/** O papel do agente e o proprio tipo do assignment: executar ou revisar. */
export function slotFor(kind: 'execute' | 'review'): AgentRole {
  return kind === 'review' ? 'reviewer' : 'executor'
}
