import type { Readable, Writable } from 'node:stream'

/** Descricao completa de um processo a executar. Sem defaults implicitos de ambiente. */
export interface RunSpec {
  command: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  timeoutMs?: number
  stdin?: string
  maxOutputBytes?: number
}

/** Motivo estruturado para um processo que nunca chegou a existir (ENOENT, EACCES...). */
export interface SpawnFailure {
  code: string
  message: string
}

export interface ExitStatus {
  code: number | null
  signal: string | null
  timedOut: boolean
  cancelled: boolean
  durationMs: number
  /** Presente apenas quando o spawn falhou; o processo nunca rodou. */
  spawnError?: SpawnFailure
  /** Presente apenas quando `cancel(reason)` foi chamado. */
  cancelReason?: string
}

export interface CapturedRun extends ExitStatus {
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  stdoutDigest: string
  stderrDigest: string
}

export interface RunningProcess {
  readonly handle: string
  readonly pid: number | null
  readonly cwd: string
  readonly startedAt: Date
  stdout(): AsyncIterable<string>
  stderr(): AsyncIterable<string>
  exit(): Promise<ExitStatus>
  cancel(reason: string): Promise<void>
}

/**
 * Subconjunto de `ChildProcess` que este pacote realmente usa. Existe para que
 * `RuntimeDeps.spawn` possa ser trocado por um duble em teste sem arrastar toda
 * a superficie do node.
 */
export interface ChildProcessLike {
  readonly pid?: number | undefined
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  readonly stdin: Writable | null
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown
}

export interface SpawnRequest {
  cwd: string
  env: Record<string, string>
  /** POSIX: lider de grupo, para que o tree-kill alcance os descendentes. */
  detached: boolean
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnRequest,
) => ChildProcessLike

/** Injecao para teste deterministico. Tudo opcional; o default e o sistema real. */
export interface RuntimeDeps {
  now?: () => number
  spawn?: SpawnFn
  newHandle?: () => string
  platform?: NodeJS.Platform
  kill?: (pid: number, signal: NodeJS.Signals) => void
  /** Espera entre SIGTERM e SIGKILL. */
  killGraceMs?: number
  /** Espera maxima entre `exit` e `close` (descendente segurando o pipe). */
  closeGraceMs?: number
}

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
export const DEFAULT_KILL_GRACE_MS = 2000
export const DEFAULT_CLOSE_GRACE_MS = 2000
