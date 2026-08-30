import { type FailureCode, type FailureReason, isFailureCode } from '@agentic/domain'

/** Erro que ja chega classificado por um adapter (runtime de agente, workspace, gate). */
interface CodedError {
  readonly failureCode?: unknown
  readonly code?: unknown
}

export class OrchestratorError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = new.target.name
    this.code = code
  }
}

export class RunNotFoundError extends OrchestratorError {
  constructor(runId: string) {
    super('RUN_NOT_FOUND', `run ${runId} nao existe`)
  }
}

export class TaskNotFoundError extends OrchestratorError {
  constructor(taskId: string) {
    super('TASK_NOT_FOUND', `task ${taskId} nao existe neste run`)
  }
}

export class CommandRefusedError extends OrchestratorError {
  constructor(detail: string) {
    super('COMMAND_REFUSED', detail)
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Traducao para o codigo fechado do dominio. O adapter que sabe classificar ja carrega o
 * codigo (`failureCode` no runtime de agente, `code` no workspace); o resto e AGENT_ERROR.
 */
export function failureCodeOf(error: unknown, fallback: FailureCode = 'AGENT_ERROR'): FailureCode {
  if (typeof error !== 'object' || error === null) return fallback
  const coded = error as CodedError
  if (isFailureCode(coded.failureCode)) return coded.failureCode
  if (isFailureCode(coded.code)) return coded.code
  return fallback
}

export function failureReasonOf(
  error: unknown,
  fallback: FailureCode = 'AGENT_ERROR',
): FailureReason {
  return { code: failureCodeOf(error, fallback), detail: describeError(error) }
}
