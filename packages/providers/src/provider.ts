import type { AgentProvider, ProviderHealth } from '@agentic/domain'

/**
 * `AgentProvider` que tambem sabe se apresentar. A porta do dominio nao pede saude do
 * provider isolado — quem agrega e o `ProviderRegistry` — mas todo adapter precisa
 * responder, entao a obrigacao vive aqui, do lado dos adapters.
 */
export interface HealthCheckedAgentProvider extends AgentProvider {
  health(): Promise<ProviderHealth>
}
