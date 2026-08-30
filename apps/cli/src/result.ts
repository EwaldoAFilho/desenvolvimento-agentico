/**
 * Resultado de um comando. Handler nao chama `process.exit`: devolve o codigo e quem
 * dirige o processo decide — e o que torna cada comando testavel como funcao.
 *
 * 0 ok · 1 erro de validacao ou execucao · 2 erro de uso.
 */
export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_USAGE = 2

export type ExitCode = typeof EXIT_OK | typeof EXIT_ERROR | typeof EXIT_USAGE

export interface CommandError {
  readonly code: string
  readonly message: string
}

export interface CommandResult {
  readonly exitCode: ExitCode
  /** Nome estavel do comando: `mission validate`, `task inspect`, ... */
  readonly command: string
  /** Carga util do `--json`. Sempre derivada dos contratos de `@agentic/schemas`. */
  readonly data?: unknown
  readonly error?: CommandError
}

export function ok(command: string, data?: unknown): CommandResult {
  return { exitCode: EXIT_OK, command, ...(data === undefined ? {} : { data }) }
}

export function failure(
  command: string,
  code: string,
  message: string,
  data?: unknown,
): CommandResult {
  return {
    exitCode: EXIT_ERROR,
    command,
    error: { code, message },
    ...(data === undefined ? {} : { data }),
  }
}

export function usage(command: string, message: string, code = 'USAGE'): CommandResult {
  return { exitCode: EXIT_USAGE, command, error: { code, message } }
}

/** Erro de execucao com codigo estavel; o runner converte em `CommandResult`. */
export class CliError extends Error {
  readonly code: string
  readonly usage: boolean

  constructor(code: string, message: string, options: { readonly usage?: boolean } = {}) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.usage = options.usage ?? false
  }
}

export function usageError(message: string, code = 'USAGE'): CliError {
  return new CliError(code, message, { usage: true })
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function codeOf(error: unknown): string {
  if (error instanceof CliError) return error.code
  const coded = error as { readonly code?: unknown }
  return typeof coded?.code === 'string' ? coded.code : 'ERROR'
}
