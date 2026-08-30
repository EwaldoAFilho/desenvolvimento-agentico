export const GATE_ERROR_CODES = [
  'GATE_CONFIG_INVALID',
  'GATE_COMMAND_SYNTAX',
  'GATE_CWD_ESCAPE',
  'GATE_ENV_NOT_ALLOWED',
] as const

export type GateErrorCode = (typeof GATE_ERROR_CODES)[number]

/**
 * Recusa do runner: configuracao invalida ou comando que nao pode rodar como escrito.
 * Nunca carrega saida de processo — saida vira artefato redigido, nunca mensagem de erro.
 */
export class GateError extends Error {
  readonly code: GateErrorCode
  readonly detail?: string

  constructor(code: GateErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'GateError'
    this.code = code
    this.detail = detail
  }
}

export function isGateError(value: unknown): value is GateError {
  return value instanceof GateError
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
