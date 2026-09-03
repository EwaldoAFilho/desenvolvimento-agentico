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
  /**
   * Cancelamento cooperativo de fora: abortar o sinal e o mesmo que `cancel(reason)`.
   * Sinal JA abortado na criacao nao chega a iniciar processo nenhum.
   */
  signal?: AbortSignal
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
  /**
   * O GRUPO de processos deixou de existir, confirmado por sonda (POSIX). `false` = o grupo
   * ainda existia quando o teto venceu: algum descendente sobreviveu ao SIGKILL alem do
   * prazo, e quem encerra nao pode presumir que ele parou. Em Windows nao ha grupo a sondar
   * e o valor e `true` por definicao (limite declarado).
   *
   * Vale para TODA forma de saida — cancel, abort, timeout, sinal ou saida natural do lider.
   * Pode passar de `false` a `true` depois de um `cancel()` posterior provar a morte.
   */
  groupTerminated: boolean
  /**
   * Pid do lider; `null` quando o processo nunca existiu. Em POSIX o grupo e `-pid`: e o que
   * quem guarda um residuo (`groupTerminated: false`) precisa para sondar de novo mais tarde,
   * quando o handle ja nao esta a mao (gate, `workspaceSetup`).
   */
  pid: number | null
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

/**
 * O que a confirmacao da morte de um grupo de processos precisa. E o subconjunto de
 * `RuntimeDeps` que tambem serve a quem NAO tem o processo a mao e so guardou o pgid — o
 * orquestrador sondando um residuo numa tentativa seguinte de encerramento.
 */
export interface GroupProbeDeps {
  readonly platform?: NodeJS.Platform
  /**
   * Espera maxima pela morte CONFIRMADA do grupo depois do SIGKILL. Sinal enviado nao e
   * grupo morto: um descendente no meio de uma syscall termina depois do `kill` voltar.
   */
  readonly groupGraceMs?: number
  /** `true` = o grupo (pgid negativo) ainda existe. Injetavel: grupo imortal nao se fabrica. */
  readonly probeGroup?: (pgid: number) => boolean
}

/** Injecao para teste deterministico. Tudo opcional; o default e o sistema real. */
export interface RuntimeDeps extends GroupProbeDeps {
  now?: () => number
  spawn?: SpawnFn
  newHandle?: () => string
  kill?: (pid: number, signal: NodeJS.Signals) => void
  /** Espera entre SIGTERM e SIGKILL. */
  killGraceMs?: number
  /** Espera maxima entre `exit` e `close` (descendente segurando o pipe). */
  closeGraceMs?: number
}

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
export const DEFAULT_KILL_GRACE_MS = 2000
export const DEFAULT_CLOSE_GRACE_MS = 2000
export const DEFAULT_GROUP_GRACE_MS = 2000
/** Intervalo entre sondas do grupo. */
export const GROUP_PROBE_INTERVAL_MS = 10
/**
 * Teto do fragmento ainda sem quebra de linha. Saida hostil (progresso com `\r`, blob
 * base64, JSON de uma linha so) nao pode crescer sem limite na memoria do pai: passando
 * daqui, o fragmento e entregue em pedacos.
 */
export const DEFAULT_MAX_LINE_CHARS = 64 * 1024
