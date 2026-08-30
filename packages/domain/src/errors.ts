/** Erro base do dominio. Nenhum erro daqui carrega detalhe de infraestrutura. */
export class DomainError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = new.target.name
    this.code = code
  }
}

export class InvalidIdError extends DomainError {
  readonly kind: string
  readonly raw: unknown
  readonly pattern: string

  constructor(kind: string, raw: unknown, pattern: string) {
    super('INVALID_ID', `${kind} invalido: ${JSON.stringify(raw)} nao casa com ${pattern}`)
    this.kind = kind
    this.raw = raw
    this.pattern = pattern
  }
}

export class InvalidPathScopeError extends DomainError {
  readonly raw: unknown
  readonly rule: string

  constructor(raw: unknown, rule: string) {
    super('INVALID_PATH_SCOPE', `escopo de caminho invalido (${rule}): ${JSON.stringify(raw)}`)
    this.raw = raw
    this.rule = rule
  }
}

export type StateMachineName = 'task' | 'run'
export type InvalidTransitionReason = 'NOT_LISTED' | 'GUARD_FAILED'

/**
 * P11: transicao nao declarada e erro de sistema. Quem lanca isto nao altera estado —
 * `applyTransition` valida antes de construir o proximo valor.
 */
export class InvalidTransitionError extends DomainError {
  readonly machine: StateMachineName
  readonly from: string | null
  readonly to: string
  readonly trigger: string
  readonly reason: InvalidTransitionReason
  readonly guard?: string

  constructor(
    machine: StateMachineName,
    from: string | null,
    to: string,
    trigger: string,
    reason: InvalidTransitionReason,
    guard?: string,
  ) {
    super(
      'INVALID_TRANSITION',
      reason === 'NOT_LISTED'
        ? `transicao nao declarada na maquina ${machine}: ${from ?? '-'} -> ${to} via ${trigger}`
        : `guarda "${guard ?? '?'}" reprovou ${from ?? '-'} -> ${to} via ${trigger} (maquina ${machine})`,
    )
    this.machine = machine
    this.from = from
    this.to = to
    this.trigger = trigger
    this.reason = reason
    this.guard = guard
  }
}

export class UnresolvedReviewPolicyError extends DomainError {
  constructor(detail: string) {
    super('UNRESOLVED_REVIEW_POLICY', `politica de revisao nao resolvida: ${detail}`)
  }
}
