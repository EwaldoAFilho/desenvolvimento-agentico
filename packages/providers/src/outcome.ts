import type {
  AgentClaims,
  AgentOutcomeStatus,
  AgentRunStatus,
  Assignment,
  ExitStatus,
  ProviderId,
} from '@agentic/domain'

export const MAX_CLAIM_SUMMARY_CHARS = 400
export const MAX_CLAIM_DETAIL_CHARS = 8000

/** `ExitStatus` do primitivo carrega `spawnError`; a porta do dominio nao. Lemos sem acoplar. */
interface ExitStatusExtras {
  readonly spawnError?: { readonly code: string; readonly message: string }
  readonly cancelReason?: string
}

export function spawnErrorOf(exit: ExitStatus): ExitStatusExtras['spawnError'] {
  return (exit as ExitStatus & ExitStatusExtras).spawnError
}

export function cancelReasonOf(exit: ExitStatus): string | undefined {
  return (exit as ExitStatus & ExitStatusExtras).cancelReason
}

/**
 * O agente nao decide o proprio resultado: quem decide e cancelamento, timeout e codigo
 * de saida, nessa ordem (P05). Nada aqui olha o que o agente disse.
 */
export function outcomeStatusFromExit(exit: ExitStatus): AgentOutcomeStatus {
  if (exit.cancelled) return 'cancelled'
  if (exit.timedOut) return 'timeout'
  return exit.code === 0 ? 'completed' : 'failed'
}

export function runStatusFor(status: AgentOutcomeStatus): AgentRunStatus {
  if (status === 'completed') return 'completed'
  if (status === 'cancelled') return 'cancelled'
  return 'failed'
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`
}

function lastMeaningfulLine(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim()
    if (line !== undefined && line.length > 0) return line
  }
  return undefined
}

/**
 * Relato do agente, montado a partir do que ele escreveu. Continua sendo `claims`: o
 * control plane armazena e nunca decide por ele.
 */
export function claimsFromOutput(
  stdout: readonly string[],
  stderr: readonly string[],
  exit: ExitStatus,
): AgentClaims {
  const spawnError = spawnErrorOf(exit)
  const fallback =
    spawnError !== undefined
      ? `agente nao iniciou (${spawnError.code})`
      : `agente nao produziu relato (exit ${exit.code ?? '-'})`
  const summary = lastMeaningfulLine(stdout) ?? lastMeaningfulLine(stderr) ?? fallback
  const detail = [...stdout, ...stderr].join('\n')
  const claims: AgentClaims = {
    summary: truncate(summary, MAX_CLAIM_SUMMARY_CHARS),
  }
  if (detail.trim().length === 0) return claims
  return { ...claims, detail: truncate(detail, MAX_CLAIM_DETAIL_CHARS) }
}

/**
 * Referencia estavel do artefato de log. Deriva do assignment, entao dois processos da
 * mesma tentativa apontam para o mesmo lugar e a referencia e reproduzivel.
 */
export function logsRefFor(providerId: ProviderId, assignment: Assignment): string {
  return `agent-log:${providerId}/${assignment.runId}/${assignment.taskId}/${assignment.attemptId}`
}
