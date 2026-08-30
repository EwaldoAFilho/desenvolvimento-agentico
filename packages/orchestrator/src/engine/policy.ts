import type {
  AttemptResult,
  Blockage,
  FailureCode,
  FailureReason,
  PathScope,
  TaskStatus,
  TaskTrigger,
} from '@agentic/domain'
import { isProviderFailure, tryPathScope } from '@agentic/domain'

/** Estados em que existe tentativa viva: sem handle em memoria, sao orfas (recovery). */
export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'RUNNING',
  'VERIFYING',
  'REVIEW',
  'INTEGRATING',
])

export const CANCELLABLE: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'PENDING',
  'READY',
  'RUNNING',
  'VERIFYING',
  'REVIEW',
  'INTEGRATING',
  'FAILED',
  'RETRY',
  'BLOCKED',
])

export const FAILED_TRIGGER: Readonly<Record<string, TaskTrigger>> = {
  RUNNING: 'ATTEMPT_FAILED',
  VERIFYING: 'GATE_FAILED',
  REVIEW: 'REVIEW_FAILED',
  INTEGRATING: 'INTEGRATION_CONFLICT',
}

export const ATTEMPT_RESULT_OF: Readonly<Record<FailureCode, AttemptResult>> = {
  AGENT_ERROR: 'ERROR',
  AGENT_TIMEOUT: 'TIMEOUT',
  NO_CHANGES: 'FAIL',
  SCOPE_VIOLATION: 'FAIL',
  GATE_FAILED: 'FAIL',
  REVIEW_FAILED: 'FAIL',
  INTEGRATION_CONFLICT: 'FAIL',
  WORKSPACE_ERROR: 'ERROR',
  INTERRUPTED: 'CANCELLED',
  POLICY_VIOLATION: 'ERROR',
  PROVIDER_UNAVAILABLE: 'ERROR',
  PROVIDER_NOT_READY: 'ERROR',
}

/** Espera minima antes de tentar de novo um workspace que falhou ao ser adquirido. */
export const DISPATCH_COOLDOWN_MS = 2_000

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** `denyPaths` do projeto pode conter padrao com glob; so o que vira PathScope e aplicavel. */
export function denyScopes(paths: readonly string[]): PathScope[] {
  const scopes: PathScope[] = []
  for (const raw of paths) {
    const scope = tryPathScope(raw)
    if (scope !== undefined) scopes.push(scope)
  }
  return scopes
}

/** Escalonamento: o bloqueio diz o que aconteceu, quem levantou e o que falta (P15). */
export function blockageFor(
  failure: FailureReason,
  now: Date,
  attemptCount: number,
  maxAttempts: number,
): Blockage {
  const kind = isProviderFailure(failure.code)
    ? 'EXTERNAL'
    : failure.code === 'SCOPE_VIOLATION' || failure.code === 'POLICY_VIOLATION'
      ? 'POLICY'
      : 'ATTEMPTS_EXHAUSTED'
  const needs = isProviderFailure(failure.code)
    ? 'correcao do ambiente do fornecedor pelo humano'
    : failure.code === 'SCOPE_VIOLATION'
      ? 'revisao humana do escopo declarado em touches'
      : 'decisao humana: ajustar a task, destravar ou pular'
  return {
    kind,
    reason: `${failure.code}${failure.detail === undefined ? '' : `: ${failure.detail}`}`,
    raisedBy: 'orchestrator',
    raisedAt: now,
    needs: `${needs} (tentativas ${attemptCount}/${maxAttempts})`,
  }
}
