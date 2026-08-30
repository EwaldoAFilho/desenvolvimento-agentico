/** Uniao fechada. Um codigo novo exige mudanca de contrato, nunca string livre. */
export const FAILURE_CODES = [
  'AGENT_ERROR',
  'AGENT_TIMEOUT',
  'NO_CHANGES',
  'SCOPE_VIOLATION',
  'GATE_FAILED',
  'REVIEW_FAILED',
  'INTEGRATION_CONFLICT',
  'WORKSPACE_ERROR',
  'INTERRUPTED',
  'POLICY_VIOLATION',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_NOT_READY',
] as const

export type FailureCode = (typeof FAILURE_CODES)[number]

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === 'string' && (FAILURE_CODES as readonly string[]).includes(value)
}

export interface FailureReason {
  readonly code: FailureCode
  readonly detail?: string
}

/**
 * Contexto de reincidencia. As contagens sao por task e **incluem a ocorrencia atual**:
 * `scopeViolationCount: 1` e a primeira violacao, `2` e a reincidente.
 */
export interface RetryContext {
  readonly scopeViolationCount?: number
  readonly workspaceErrorCount?: number
}

const ALWAYS_RETRYABLE: ReadonlySet<string> = new Set<FailureCode>([
  'AGENT_ERROR',
  'AGENT_TIMEOUT',
  'GATE_FAILED',
  'REVIEW_FAILED',
  'INTEGRATION_CONFLICT',
  'INTERRUPTED',
  'NO_CHANGES',
])

const NEVER_RETRYABLE: ReadonlySet<string> = new Set<FailureCode>([
  'POLICY_VIOLATION',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_NOT_READY',
])

/** Falhas de ambiente de fornecedor: a correcao e do humano, nao do agente. */
const PROVIDER_FAILURES: ReadonlySet<string> = new Set<FailureCode>([
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_NOT_READY',
])

export function isProviderFailure(code: FailureCode): boolean {
  return PROVIDER_FAILURES.has(code)
}

/** STATE-MACHINES 1.3. Reincidencia torna SCOPE_VIOLATION e WORKSPACE_ERROR nao retentaveis. */
export function isRetryable(code: FailureCode, ctx: RetryContext = {}): boolean {
  if (NEVER_RETRYABLE.has(code)) return false
  if (code === 'SCOPE_VIOLATION') return (ctx.scopeViolationCount ?? 1) < 2
  if (code === 'WORKSPACE_ERROR') return (ctx.workspaceErrorCount ?? 1) < 2
  return ALWAYS_RETRYABLE.has(code)
}

/** Falha de fornecedor e registrada como tentativa (I5) mas nao queima orcamento (I4). */
export function consumesAttempt(code: FailureCode): boolean {
  return !isProviderFailure(code)
}
