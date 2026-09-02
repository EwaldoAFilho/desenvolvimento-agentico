import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import nodeProcess from 'node:process'
import { StreamSink } from './output.js'
import type {
  CapturedRun,
  ChildProcessLike,
  ExitStatus,
  GroupProbeDeps,
  RunningProcess,
  RunSpec,
  RuntimeDeps,
  SpawnFailure,
  SpawnFn,
} from './types.js'
import {
  DEFAULT_CLOSE_GRACE_MS,
  DEFAULT_GROUP_GRACE_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  GROUP_PROBE_INTERVAL_MS,
} from './types.js'

const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    detached: options.detached,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

function toFailure(error: unknown): SpawnFailure {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'SPAWN_FAILED'
    return { code, message: error.message }
  }
  return { code: 'SPAWN_FAILED', message: String(error) }
}

function errorCode(error: unknown): string | null {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  return null
}

/** O motivo do sinal vira o `cancelReason` do relato; sem motivo, uma frase honesta. */
function abortReasonOf(signal: AbortSignal): string {
  const reason: unknown = signal.reason
  if (typeof reason === 'string' && reason.length > 0) return reason
  if (reason instanceof Error && reason.message.length > 0) return reason.message
  return 'cancelado por sinal de abort'
}

/**
 * O grupo de processos ainda existia quando o teto da confirmacao venceu. Quem pediu o
 * cancelamento nao pode tratar isso como "parou": e o oposto — um efeito que o dono nao
 * conseguiu provar morto, e a posse nao pode sair enquanto ele durar (I15).
 */
export class ProcessGroupAliveError extends Error {
  readonly code = 'PROCESS_GROUP_ALIVE'
  readonly pgid: number
  readonly graceMs: number

  constructor(pgid: number, graceMs: number) {
    super(
      `grupo de processos ${pgid} ainda existe ${graceMs}ms depois do SIGKILL: algum descendente ` +
        'nao morreu, e o encerramento nao pode presumir que ele parou (I15)',
    )
    this.name = 'ProcessGroupAliveError'
    this.pgid = pgid
    this.graceMs = graceMs
  }
}

export function isProcessGroupAliveError(value: unknown): value is ProcessGroupAliveError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly code?: unknown }).code === 'PROCESS_GROUP_ALIVE'
  )
}

/**
 * Sonda padrao: `kill(pgid, 0)` nao entrega sinal; EPERM significa que existe e nao e nosso.
 * Recebe o pgid NEGATIVO (`-pid` do lider), como todo sinal ao grupo.
 */
export function isProcessGroupAlive(pgid: number): boolean {
  try {
    nodeProcess.kill(pgid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Sonda o grupo do lider `pid` ate ele deixar de existir, com teto. `true` = confirmado
 * morto; `false` = ainda existia quando o teto venceu. Serve ao runtime no assentamento e a
 * quem guardou so o pid de um residuo e precisa sondar de novo (encerramento repetido, C3).
 * Em Windows nao ha grupo a sondar: `true` por definicao (limite declarado).
 */
export async function confirmProcessGroupGone(
  pid: number,
  deps: GroupProbeDeps = {},
): Promise<boolean> {
  if ((deps.platform ?? nodeProcess.platform) === 'win32') return true
  const probe = deps.probeGroup ?? isProcessGroupAlive
  // Uma sonda que LANCA nao provou nada: conta como "ainda existe" (falha fechado) em vez de
  // virar rejeicao — esta funcao e chamada de caminhos sem quem espere (`void #finish()`).
  const alive = (): boolean => {
    try {
      return probe(-pid)
    } catch {
      return true
    }
  }
  // Relogio REAL, nao um injetado: o teto e espera de parede.
  const deadline = Date.now() + (deps.groupGraceMs ?? DEFAULT_GROUP_GRACE_MS)
  for (;;) {
    if (!alive()) return true
    if (Date.now() >= deadline) return false
    await sleep(GROUP_PROBE_INTERVAL_MS)
  }
}

function toBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
}

class ManagedProcess implements RunningProcess {
  readonly handle: string
  readonly cwd: string
  readonly startedAt: Date

  readonly #now: () => number
  readonly #platform: NodeJS.Platform
  readonly #kill: (pid: number, signal: NodeJS.Signals) => void
  readonly #killGraceMs: number
  readonly #closeGraceMs: number
  readonly #groupGraceMs: number
  readonly #probeGroup: (pgid: number) => boolean
  #finishing = false
  readonly #startedAtMs: number
  readonly #out: StreamSink
  readonly #err: StreamSink
  readonly #exitWaiters: ((status: ExitStatus) => void)[] = []

  #child: ChildProcessLike | null = null
  #pid: number | null = null
  #timedOut = false
  #cancelled = false
  #cancelReason: string | null = null
  #spawnError: SpawnFailure | null = null
  #status: ExitStatus | null = null
  #observedCode: number | null = null
  #observedSignal: string | null = null
  #timeoutTimer: NodeJS.Timeout | null = null
  #closeTimer: NodeJS.Timeout | null = null
  #desligarAbort: (() => void) | null = null

  constructor(spec: RunSpec, deps: RuntimeDeps = {}) {
    this.#now = deps.now ?? Date.now
    this.#platform = deps.platform ?? nodeProcess.platform
    this.#kill = deps.kill ?? ((pid, signal) => nodeProcess.kill(pid, signal))
    this.#killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    this.#closeGraceMs = deps.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS
    this.#groupGraceMs = deps.groupGraceMs ?? DEFAULT_GROUP_GRACE_MS
    this.#probeGroup = deps.probeGroup ?? isProcessGroupAlive
    this.handle = (deps.newHandle ?? (() => `proc_${randomUUID()}`))()
    this.cwd = spec.cwd
    this.#startedAtMs = this.#now()
    this.startedAt = new Date(this.#startedAtMs)

    const limit = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.#out = new StreamSink(limit)
    this.#err = new StreamSink(limit)

    // Sinal ja abortado: nao ha o que iniciar. O processo nunca existe e o relato diz por que.
    const signal = spec.signal
    if (signal?.aborted === true) {
      this.#cancelled = true
      this.#cancelReason = abortReasonOf(signal)
      this.#settle(null, null)
      return
    }

    const spawnFn = deps.spawn ?? defaultSpawn
    let child: ChildProcessLike
    try {
      child = spawnFn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...spec.env },
        detached: this.#platform !== 'win32',
      })
    } catch (error) {
      this.#spawnError = toFailure(error)
      this.#settle(null, null)
      return
    }

    this.#child = child
    this.#pid = typeof child.pid === 'number' ? child.pid : null
    this.#wire(child, spec)
    if (signal !== undefined) {
      // Ninguem espera este cancelamento, entao ele nao pode prometer nada a ninguem: pede o
      // encerramento e deixa o desfecho — inclusive "grupo ainda vivo" — sair por `exit()`.
      // Chamar `cancel()` aqui, que REJEITA com o grupo vivo, era uma rejeicao orfa (C1).
      const onAbort = (): void => {
        if (this.#requestCancel(abortReasonOf(signal))) void this.#terminate()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.#desligarAbort = () => signal.removeEventListener('abort', onAbort)
    }
  }

  get pid(): number | null {
    return this.#pid
  }

  stdout(): AsyncIterable<string> {
    return this.#out.lines()
  }

  stderr(): AsyncIterable<string> {
    return this.#err.lines()
  }

  exit(): Promise<ExitStatus> {
    const settled = this.#status
    if (settled !== null) return Promise.resolve(settled)
    return new Promise<ExitStatus>((resolve) => {
      this.#exitWaiters.push(resolve)
    })
  }

  /**
   * O contrato de `cancel()` (ADR-0014, 004B):
   *
   * - PEDE o cancelamento (SIGTERM a arvore, SIGKILL apos o teto) e ESPERA o assentamento.
   * - RESOLVE somente com o grupo de processos CONFIRMADO morto.
   * - REJEITA com `ProcessGroupAliveError` se o grupo ainda existir depois do teto: sinal
   *   enviado nao e processo morto, e quem chamou nao pode fingir que terminou.
   * - Chamado de novo mais tarde — inclusive depois de o lider ja ter saido por conta propria
   *   — SONDA OUTRA VEZ: o grupo pode ter morrido nesse meio tempo, e ai resolve e `exit()`
   *   passa a relatar `groupTerminated: true`.
   *
   * Quem nao pode esperar (AbortSignal, timeout) nao chama isto: usa `#requestCancel`, e o
   * desfecho sai por `exit()`.
   */
  async cancel(reason: string): Promise<void> {
    if (this.#requestCancel(reason)) await this.#terminate()
    const status = await this.exit()
    if (status.groupTerminated) return
    const pid = this.#pid
    if (pid === null) return
    if (await this.#confirmGroupGone(pid)) {
      this.#status = Object.freeze({ ...status, groupTerminated: true })
      return
    }
    throw new ProcessGroupAliveError(-pid, this.#groupGraceMs)
  }

  /**
   * Marca o cancelamento e dispara o encerramento SEM esperar por ele. Nunca rejeita: e o
   * caminho de quem nao tem como tratar uma rejeicao (listener de abort, timer de timeout).
   * `true` = este pedido e o primeiro e o encerramento foi iniciado por ele.
   */
  #requestCancel(reason: string): boolean {
    if (this.#status !== null || this.#cancelled) return false
    this.#cancelled = true
    this.#cancelReason = reason
    return true
  }

  captured(): CapturedRun {
    const status = this.#status
    if (status === null) throw new Error('captured() antes do fim do processo')
    return {
      ...status,
      stdout: this.#out.text(),
      stderr: this.#err.text(),
      stdoutTruncated: this.#out.truncated,
      stderrTruncated: this.#err.truncated,
      stdoutDigest: this.#out.digest(),
      stderrDigest: this.#err.digest(),
    }
  }

  #wire(child: ChildProcessLike, spec: RunSpec): void {
    const { stdout, stderr, stdin } = child

    if (stdout === null) {
      this.#out.end()
    } else {
      stdout.on('data', (chunk: Buffer | string) => this.#out.push(toBuffer(chunk)))
      stdout.on('error', () => this.#out.end())
      stdout.on('end', () => this.#out.end())
      stdout.on('close', () => this.#out.end())
    }

    if (stderr === null) {
      this.#err.end()
    } else {
      stderr.on('data', (chunk: Buffer | string) => this.#err.push(toBuffer(chunk)))
      stderr.on('error', () => this.#err.end())
      stderr.on('end', () => this.#err.end())
      stderr.on('close', () => this.#err.end())
    }

    if (stdin !== null) {
      // EPIPE quando o filho fecha stdin antes de ler: nao e falha nossa.
      stdin.on('error', () => {})
      if (spec.stdin === undefined) stdin.end()
      else stdin.end(spec.stdin)
    }

    child.on('error', (error: Error) => {
      this.#spawnError = toFailure(error)
      if (this.#pid === null) this.#settle(null, null)
    })

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.#observedCode = code
      this.#observedSignal = signal
      this.#armCloseGuard()
    })

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      void this.#finish(code ?? this.#observedCode, signal ?? this.#observedSignal)
    })

    const timeoutMs = spec.timeoutMs
    if (timeoutMs !== undefined && timeoutMs > 0) {
      this.#timeoutTimer = setTimeout(() => {
        if (this.#status !== null) return
        this.#timedOut = true
        void this.#terminate()
      }, timeoutMs)
    }
  }

  /** `close` espera os pipes; um descendente vivo pode segura-los para sempre. */
  #armCloseGuard(): void {
    if (this.#closeTimer !== null || this.#status !== null) return
    this.#closeTimer = setTimeout(() => {
      void this.#finish(this.#observedCode, this.#observedSignal)
      // solta os pipes que sobreviveram ao filho, senao o processo pai fica preso
      this.#child?.stdout?.destroy()
      this.#child?.stderr?.destroy()
    }, this.#closeGraceMs)
  }

  /**
   * O lider assentou. Antes de o processo ser dado por encerrado: o resto do grupo recebe
   * SIGKILL e a morte do grupo e CONFIRMADA por sonda, com teto. So entao `exit()` resolve —
   * com `groupTerminated` dizendo se a confirmacao veio ou se o teto venceu.
   */
  async #finish(code: number | null, signal: string | null): Promise<void> {
    if (this.#finishing || this.#status !== null) return
    this.#finishing = true
    const pid = this.#pid
    let terminated = true
    if (pid !== null) {
      this.#killGroupRemainder(pid)
      terminated = await this.#confirmGroupGone(pid)
    }
    this.#settle(code, signal, terminated)
  }

  /** `true` quando o grupo deixou de existir dentro do teto; `false` se ainda existia. */
  #confirmGroupGone(pid: number): Promise<boolean> {
    return confirmProcessGroupGone(pid, {
      platform: this.#platform,
      groupGraceMs: this.#groupGraceMs,
      probeGroup: this.#probeGroup,
    })
  }

  async #terminate(): Promise<void> {
    const pid = this.#pid
    if (pid === null || this.#status !== null) return
    this.#signalTree(pid, 'SIGTERM')
    const exited = await this.#waitForExit(this.#killGraceMs)
    if (!exited) this.#signalTree(pid, 'SIGKILL')
  }

  /**
   * O lider saiu, mas o GRUPO pode nao ter saido.
   *
   * Um descendente que nao segura os pipes (`stdio: ignore`) sobrevive ao `close` do lider —
   * tanto quando o lider e cancelado e sai educadamente no SIGTERM quanto quando ele termina
   * SOZINHO, deixando um daemon para tras. Esse descendente continuaria mutando a worktree
   * depois de o processo assentar, depois do `close` do control plane e depois de outro dono
   * assumir (I15). Medido em revisao, nas duas formas.
   *
   * A unidade do efeito e o GRUPO, entao o grupo termina com o lider, sempre: o que ainda
   * estiver nele recebe SIGKILL no instante em que o lider assenta. So `-pid`, nunca `pid`:
   * o lider ja morreu, e um pid reaproveitado nao e nosso. Limite declarado: um descendente
   * que trocou de sessao (`setsid`) saiu do grupo e deste alcance.
   */
  #killGroupRemainder(pid: number): void {
    if (this.#platform === 'win32') return
    try {
      this.#kill(-pid, 'SIGKILL')
    } catch {
      // ESRCH: nao sobrou ninguem no grupo — e o desfecho normal.
    }
  }

  /**
   * Tree-kill: em POSIX o filho foi criado com `detached`, entao pid == pgid e o
   * sinal negativo alcanca toda a arvore. Matar so o pid deixaria netos orfaos.
   */
  #signalTree(pid: number, signal: NodeJS.Signals): void {
    if (this.#platform === 'win32') {
      this.#killWindowsTree(pid, signal)
      return
    }
    try {
      this.#kill(-pid, signal)
      return
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return
    }
    try {
      this.#kill(pid, signal)
    } catch {
      // processo ja saiu entre a checagem e o sinal
    }
  }

  #killWindowsTree(pid: number, signal: NodeJS.Signals): void {
    try {
      const killer = nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => {
        this.#child?.kill(signal)
      })
      killer.unref()
    } catch {
      this.#child?.kill(signal)
    }
  }

  #waitForExit(ms: number): Promise<boolean> {
    if (this.#status !== null) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish(false), ms)
      this.#exitWaiters.push(() => finish(true))
    })
  }

  #settle(code: number | null, signal: string | null, groupTerminated = true): void {
    if (this.#status !== null) return
    if (this.#timeoutTimer !== null) clearTimeout(this.#timeoutTimer)
    if (this.#closeTimer !== null) clearTimeout(this.#closeTimer)
    this.#desligarAbort?.()
    this.#desligarAbort = null
    this.#timeoutTimer = null
    this.#closeTimer = null
    this.#out.end()
    this.#err.end()

    const status: ExitStatus = {
      code,
      signal,
      timedOut: this.#timedOut,
      cancelled: this.#cancelled,
      groupTerminated,
      pid: this.#pid,
      durationMs: Math.max(0, this.#now() - this.#startedAtMs),
    }
    if (this.#spawnError !== null) status.spawnError = this.#spawnError
    if (this.#cancelReason !== null) status.cancelReason = this.#cancelReason

    this.#status = Object.freeze(status)
    const waiters = this.#exitWaiters.splice(0, this.#exitWaiters.length)
    for (const waiter of waiters) waiter(this.#status)
  }
}

/** Executa e captura tudo. Nunca lanca por falha do processo — o resultado e o relato. */
export async function runCaptured(spec: RunSpec, deps?: RuntimeDeps): Promise<CapturedRun> {
  const managed = new ManagedProcess(spec, deps)
  await managed.exit()
  return managed.captured()
}

/** Processo longo: streams incrementais, cancelavel, com a mesma semantica de saida. */
export function spawnStreaming(spec: RunSpec, deps?: RuntimeDeps): RunningProcess {
  return new ManagedProcess(spec, deps)
}
