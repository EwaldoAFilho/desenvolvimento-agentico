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
  /** Ver `AgentProfile.simulated`. Herdado do perfil na hora de montar a identidade. */
  readonly simulated?: boolean
}

export interface AgentProfile {
  readonly id: AgentProfileId
  readonly role: AgentRole
  readonly providerId: ProviderId
  readonly model?: string
  readonly systemContextRef?: string
  readonly tags: readonly string[]
  /**
   * Perfil de ENSAIO: o agente por tras dele e um roteiro, nao uma sessao de verdade.
   *
   * Serve a teste, demonstracao e preview — e essa e a unica coisa que ele serve. Revisao e
   * a segunda leitura INDEPENDENTE da evidencia (P07, I3); um roteiro nao le nada, entao um
   * perfil de ensaio nunca satisfaz revisao de tentativa real, em politica nenhuma.
   *
   * O dominio nao sabe QUEM e de ensaio: quem monta os perfis marca o campo. Nenhum nome de
   * fornecedor entra aqui (P18).
   */
  readonly simulated?: boolean
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
