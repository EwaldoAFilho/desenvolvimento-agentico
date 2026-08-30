import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import nodeProcess from 'node:process'
import { StreamSink } from './output.js'
import type {
  CapturedRun,
  ChildProcessLike,
  ExitStatus,
  RunningProcess,
  RunSpec,
  RuntimeDeps,
  SpawnFailure,
  SpawnFn,
} from './types.js'
import { DEFAULT_CLOSE_GRACE_MS, DEFAULT_KILL_GRACE_MS, DEFAULT_MAX_OUTPUT_BYTES } from './types.js'

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

  constructor(spec: RunSpec, deps: RuntimeDeps = {}) {
    this.#now = deps.now ?? Date.now
    this.#platform = deps.platform ?? nodeProcess.platform
    this.#kill = deps.kill ?? ((pid, signal) => nodeProcess.kill(pid, signal))
    this.#killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    this.#closeGraceMs = deps.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS
    this.handle = (deps.newHandle ?? (() => `proc_${randomUUID()}`))()
    this.cwd = spec.cwd
    this.#startedAtMs = this.#now()
    this.startedAt = new Date(this.#startedAtMs)

    const limit = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.#out = new StreamSink(limit)
    this.#err = new StreamSink(limit)

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

  async cancel(reason: string): Promise<void> {
    if (this.#status === null && !this.#cancelled) {
      this.#cancelled = true
      this.#cancelReason = reason
      await this.#terminate()
    }
    await this.exit()
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
      this.#settle(code ?? this.#observedCode, signal ?? this.#observedSignal)
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
      this.#settle(this.#observedCode, this.#observedSignal)
      // solta os pipes que sobreviveram ao filho, senao o processo pai fica preso
      this.#child?.stdout?.destroy()
      this.#child?.stderr?.destroy()
    }, this.#closeGraceMs)
  }

  async #terminate(): Promise<void> {
    const pid = this.#pid
    if (pid === null || this.#status !== null) return
    this.#signalTree(pid, 'SIGTERM')
    const exited = await this.#waitForExit(this.#killGraceMs)
    if (!exited) this.#signalTree(pid, 'SIGKILL')
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

  #settle(code: number | null, signal: string | null): void {
    if (this.#status !== null) return
    if (this.#timeoutTimer !== null) clearTimeout(this.#timeoutTimer)
    if (this.#closeTimer !== null) clearTimeout(this.#closeTimer)
    this.#timeoutTimer = null
    this.#closeTimer = null
    this.#out.end()
    this.#err.end()

    const status: ExitStatus = {
      code,
      signal,
      timedOut: this.#timedOut,
      cancelled: this.#cancelled,
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
