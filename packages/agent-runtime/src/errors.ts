import type { FailureCode, FailureReason, ProviderId } from '@agentic/domain'

/**
 * Erro do runtime que ja chega classificado: quem captura nao adivinha o FailureCode.
 * A traducao para transicao de estado continua sendo do orquestrador (ADR-0012).
 */
export class AgentRuntimeError extends Error {
  readonly failureCode: FailureCode
  readonly providerId: ProviderId
  readonly detail: string

  constructor(failureCode: FailureCode, providerId: ProviderId, detail: string) {
    super(`[${failureCode}] ${providerId}: ${detail}`)
    this.name = new.target.name
    this.failureCode = failureCode
    this.providerId = providerId
    this.detail = detail
  }

  toFailureReason(): FailureReason {
    return { code: this.failureCode, detail: this.detail }
  }
}

/** Executavel do provider ausente ou impossivel de iniciar: correcao e do humano. */
export class ProviderUnavailableError extends AgentRuntimeError {
  constructor(providerId: ProviderId, detail: string) {
    super('PROVIDER_UNAVAILABLE', providerId, detail)
  }
}

/** Executavel existe mas nao esta apto a executar (tipicamente sem autenticacao). */
export class ProviderNotReadyError extends AgentRuntimeError {
  constructor(providerId: ProviderId, detail: string) {
    super('PROVIDER_NOT_READY', providerId, detail)
  }
}

/** I11: todo processo de agente inicia com `cwd` na worktree da tentativa. */
export class WorkspaceCwdError extends AgentRuntimeError {
  readonly cwd: string

  constructor(providerId: ProviderId, cwd: string, detail: string) {
    super('WORKSPACE_ERROR', providerId, detail)
    this.cwd = cwd
  }
}

export function isAgentRuntimeError(value: unknown): value is AgentRuntimeError {
  return value instanceof AgentRuntimeError
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
