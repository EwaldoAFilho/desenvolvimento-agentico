import type { CapacitySnapshot, ProviderId } from '@agentic/domain'

/** Recorte por provider do `CapacitySnapshot` do dominio (DOMAIN-MODEL 4.6). */
export type ProviderCapacitySnapshot = CapacitySnapshot['byProvider']

export type CapacityDenialReason = 'AT_CAPACITY' | 'UNKNOWN_PROVIDER'
export type CapacityReleaseRefusalReason = 'NOT_HELD' | 'UNKNOWN_PROVIDER'

export interface CapacityUsage {
  readonly running: number
  readonly capacity: number | null
}

export interface CapacityAcquired {
  readonly ok: true
  readonly providerId: ProviderId
  readonly running: number
  readonly capacity: number
}

export interface CapacityDenied {
  readonly ok: false
  readonly providerId: ProviderId
  readonly reason: CapacityDenialReason
  readonly running: number
  readonly capacity: number | null
  readonly detail: string
}

export type CapacityAcquisition = CapacityAcquired | CapacityDenied

export interface CapacityReleased {
  readonly ok: true
  readonly providerId: ProviderId
  readonly running: number
  readonly capacity: number
}

export interface CapacityReleaseRefused {
  readonly ok: false
  readonly providerId: ProviderId
  readonly reason: CapacityReleaseRefusalReason
  readonly running: number
  readonly capacity: number | null
  readonly detail: string
}

export type CapacityRelease = CapacityReleased | CapacityReleaseRefused

function normalizeLimit(raw: number): number {
  if (!Number.isFinite(raw)) return 0
  return Math.max(0, Math.floor(raw))
}

/**
 * Contabilidade de vagas por provider. Pura: sem relogio, sem IO, sem excecao.
 * Uma vaga e uma vaga — execucao e revisao disputam a mesma conta (DOMAIN-MODEL 4.6),
 * e I9 se resume a nunca despachar sem um `acquire` que retornou `ok`.
 */
export class CapacityLedger {
  readonly #limits = new Map<string, number>()
  readonly #running = new Map<string, number>()

  constructor(limits: Readonly<Record<string, number>> = {}) {
    for (const [id, max] of Object.entries(limits)) this.#limits.set(id, normalizeLimit(max))
  }

  acquire(providerId: ProviderId): CapacityAcquisition {
    const capacity = this.#limits.get(providerId)
    const running = this.#running.get(providerId) ?? 0
    if (capacity === undefined) {
      return {
        ok: false,
        providerId,
        reason: 'UNKNOWN_PROVIDER',
        running,
        capacity: null,
        detail: `provider "${providerId}" nao tem maxConcurrent configurado`,
      }
    }
    if (running >= capacity) {
      return {
        ok: false,
        providerId,
        reason: 'AT_CAPACITY',
        running,
        capacity,
        detail: `sem vaga em "${providerId}": ${running}/${capacity} em uso`,
      }
    }
    const next = running + 1
    this.#running.set(providerId, next)
    return { ok: true, providerId, running: next, capacity }
  }

  release(providerId: ProviderId): CapacityRelease {
    const capacity = this.#limits.get(providerId)
    const running = this.#running.get(providerId) ?? 0
    if (capacity === undefined) {
      return {
        ok: false,
        providerId,
        reason: 'UNKNOWN_PROVIDER',
        running,
        capacity: null,
        detail: `provider "${providerId}" nao tem maxConcurrent configurado`,
      }
    }
    if (running <= 0) {
      return {
        ok: false,
        providerId,
        reason: 'NOT_HELD',
        running: 0,
        capacity,
        detail: `nada a liberar em "${providerId}": nenhuma vaga em uso`,
      }
    }
    const next = running - 1
    this.#running.set(providerId, next)
    return { ok: true, providerId, running: next, capacity }
  }

  usage(providerId: ProviderId): CapacityUsage {
    const capacity = this.#limits.get(providerId)
    return {
      running: this.#running.get(providerId) ?? 0,
      capacity: capacity === undefined ? null : capacity,
    }
  }

  /** Retrato novo a cada chamada: mutar o resultado nao altera a conta. */
  snapshot(): ProviderCapacitySnapshot {
    const out: Record<string, { maxConcurrent: number; running: number }> = {}
    for (const [id, maxConcurrent] of this.#limits) {
      out[id] = { maxConcurrent, running: this.#running.get(id) ?? 0 }
    }
    return out
  }
}
