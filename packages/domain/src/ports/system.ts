import type { CommandResult } from '../gate.js'
import type { AttemptId, RunId } from '../ids.js'

export interface ProcessCommand {
  readonly run: string
  readonly cwd: string
  /** Allowlist explicita: nenhuma variavel alem desta e repassada (P08/P17). */
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly captureLimitBytes?: number
}

/** Unico caminho do dominio para executar comando. A implementacao vive fora. */
export interface ProcessRunner {
  run(command: ProcessCommand): Promise<CommandResult>
}

/** Porta para tornar a maquina de estados deterministica em teste (ARCHITECTURE 2). */
export interface Clock {
  now(): Date
  monotonicMs(): number
}

export interface IdGenerator {
  runId(): RunId
  attemptId(): AttemptId
  next(prefix?: string): string
}
