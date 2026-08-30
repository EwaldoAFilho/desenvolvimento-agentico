import type { CapacityDenialReason } from '@agentic/agent-runtime'
import type { ProviderId } from '@agentic/domain'

/**
 * Recusa de despacho por falta de vaga (I9). Nao e `FailureCode`: nenhum codigo do
 * dominio descreve "o control plane pediu mais do que declarou" — isso e defeito nosso,
 * nao falha do fornecedor. O adapter recusa para que a invariante nao dependa apenas da
 * disciplina do scheduler.
 */
export class ProviderAtCapacityError extends Error {
  readonly providerId: ProviderId
  readonly reason: CapacityDenialReason
  readonly running: number
  readonly capacity: number | null

  constructor(
    providerId: ProviderId,
    reason: CapacityDenialReason,
    running: number,
    capacity: number | null,
    detail: string,
  ) {
    super(`[${reason}] ${providerId}: ${detail}`)
    this.name = new.target.name
    this.providerId = providerId
    this.reason = reason
    this.running = running
    this.capacity = capacity
  }
}

/** `get` de provider ausente do registry. Configuracao errada, nao falha de execucao. */
export class UnknownProviderError extends Error {
  readonly providerId: ProviderId
  readonly known: readonly ProviderId[]

  constructor(providerId: ProviderId, known: readonly ProviderId[]) {
    super(`provider "${providerId}" nao esta no registry (conhecidos: ${known.join(', ') || '-'})`)
    this.name = new.target.name
    this.providerId = providerId
    this.known = known
  }
}

/**
 * Adapter declarado com `readinessProbe: 'supported'` mas sem como perguntar prontidao.
 * Recusamos na construcao: declarar suporte inexistente e o erro que ADR-0010 proibe.
 */
export class InvalidProviderDescriptorError extends Error {
  readonly providerId: string

  constructor(providerId: string, detail: string) {
    super(`descritor invalido para "${providerId}": ${detail}`)
    this.name = new.target.name
    this.providerId = providerId
  }
}

export function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
