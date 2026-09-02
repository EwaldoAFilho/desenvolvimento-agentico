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

/**
 * O encerramento excedeu o prazo com efeito ainda em voo (I15).
 *
 * Quem recebe isto NAO devolve a posse: um projeto que continua possuido por um processo
 * que ainda esta terminando e o mal menor — a posse morre com o processo de qualquer jeito,
 * e entregar o projeto com efeito vivo e o dano de D4 voltando por um caminho de falha.
 */
export class ShutdownTimeoutError extends OrchestratorError {
  readonly runId: string
  readonly graceMs: number
  readonly pendingJobs: number
  readonly chainBusy: boolean
  readonly inflightAttempts: readonly string[]
  /** Processos cujo grupo NAO foi confirmado morto: sinal enviado nao e processo morto. */
  readonly residualProcesses: readonly string[]

  constructor(input: {
    readonly runId: string
    readonly graceMs: number
    readonly pendingJobs: number
    readonly chainBusy: boolean
    readonly inflightAttempts: readonly string[]
    readonly residualProcesses?: readonly string[]
  }) {
    const residual = input.residualProcesses ?? []
    const what = [
      input.chainBusy ? 'tick em execucao' : undefined,
      input.pendingJobs > 0 ? `${input.pendingJobs} efeito(s) assincrono(s)` : undefined,
      input.inflightAttempts.length > 0
        ? `tentativas ${input.inflightAttempts.join(', ')}`
        : undefined,
      residual.length > 0
        ? `grupo(s) de processos ainda vivo(s): ${residual.join(', ')}`
        : undefined,
    ]
      .filter((part) => part !== undefined)
      .join('; ')
    super(
      'SHUTDOWN_TIMEOUT',
      `run ${input.runId}: encerramento excedeu ${input.graceMs}ms com efeito ainda em voo ` +
        `(${what}); a posse do projeto NAO e devolvida enquanto isso durar (I15)`,
    )
    this.runId = input.runId
    this.graceMs = input.graceMs
    this.pendingJobs = input.pendingJobs
    this.chainBusy = input.chainBusy
    this.inflightAttempts = input.inflightAttempts
    this.residualProcesses = residual
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
