import type { AgentProfileId, ProviderId } from './ids.js'

export const AGENT_ROLES = ['executor', 'reviewer'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

/** Referencia ao processo local que executou a tentativa (P17 / I11). */
export interface AgentRuntimeRef {
  readonly handle: string
  readonly pid: number | null
  readonly cwd: string
  readonly startedAt: Date
}

/**
 * Executor e revisor nao sao entidades: sao papeis desta identidade dentro de uma tentativa
 * (DOMAIN-MODEL 3.5). `sessionRef` e a chave de identidade — sessao nova, identidade nova.
 */
export interface AgentIdentity {
  readonly profileId: AgentProfileId
  readonly providerId: ProviderId
  readonly model?: string
  readonly sessionRef: string
  readonly startedAt: Date
  readonly runtime?: AgentRuntimeRef
}

export interface AgentProfile {
  readonly id: AgentProfileId
  readonly role: AgentRole
  readonly providerId: ProviderId
  readonly model?: string
  readonly systemContextRef?: string
  readonly tags: readonly string[]
}

export function isSameAgentIdentity(a: AgentIdentity, b: AgentIdentity): boolean {
  return a.sessionRef === b.sessionRef
}

export function isSameProvider(a: AgentIdentity, b: AgentIdentity): boolean {
  return a.providerId === b.providerId
}

export function isSameProfile(a: AgentIdentity, b: AgentIdentity): boolean {
  return a.profileId === b.profileId
}
