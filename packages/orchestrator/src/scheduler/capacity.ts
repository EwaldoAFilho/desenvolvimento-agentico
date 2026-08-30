import type { CapacitySnapshot, ProviderId, RunPolicies } from '@agentic/domain'

export type SlotKind = 'executor' | 'reviewer'

/**
 * Vagas restantes. `RunPolicies` e `CapacitySnapshot` declaram os mesmos tetos por
 * caminhos diferentes (politica do run x contabilidade do registry): vale o menor dos
 * dois, de modo que respeitar um nunca significa violar o outro.
 *
 * Provider ausente de `byProvider` e tratado como indisponivel: sem teto conhecido nao ha
 * como garantir I9, e inventar capacidade seria pior que esperar o proximo tick.
 */
export class Budget {
  private global: number
  private executor: number
  private reviewer: number
  private readonly byProvider: Map<string, number>

  constructor(policies: RunPolicies, capacity: CapacitySnapshot) {
    this.global = free(
      Math.min(policies.maxParallelTasks, capacity.global.maxParallelTasks),
      capacity.global.active,
    )
    this.executor = free(
      Math.min(policies.maxExecutors, capacity.executor.max),
      capacity.executor.active,
    )
    this.reviewer = free(
      Math.min(policies.maxReviewers, capacity.reviewer.max),
      capacity.reviewer.active,
    )
    this.byProvider = new Map()
    for (const [id, provider] of Object.entries(capacity.byProvider)) {
      this.byProvider.set(id, free(provider.maxConcurrent, provider.running))
    }
  }

  hasSlot(kind: SlotKind): boolean {
    if (this.global <= 0) return false
    return kind === 'executor' ? this.executor > 0 : this.reviewer > 0
  }

  hasProvider(provider: ProviderId): boolean {
    return (this.byProvider.get(provider) ?? 0) > 0
  }

  /** So consome quando ha vaga nos tres tetos ao mesmo tempo. */
  reserve(kind: SlotKind, provider: ProviderId): boolean {
    if (!this.hasSlot(kind) || !this.hasProvider(provider)) return false
    this.global -= 1
    if (kind === 'executor') this.executor -= 1
    else this.reviewer -= 1
    this.byProvider.set(provider, (this.byProvider.get(provider) ?? 0) - 1)
    return true
  }
}

function free(max: number, active: number): number {
  return Math.max(0, max - active)
}
