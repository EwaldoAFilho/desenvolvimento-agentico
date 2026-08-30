import { isAbsolute } from 'node:path'
import nodeProcess from 'node:process'
import type {
  LocalAgentProcess,
  LocalAgentRuntime,
  LocalAgentSpec,
  ProviderHealth,
  SpawnOptions,
} from '@agentic/domain'
import type { ExitStatus, RunningProcess } from '@agentic/process'
import { spawnStreaming } from '@agentic/process'
import { describeError, ProviderUnavailableError, WorkspaceCwdError } from './errors.js'
import { probeLocalAgent } from './probe.js'
import { isDirectory as defaultIsDirectory, resolveExecutable } from './resolve.js'
import type { LocalAgentRuntimeDeps, ProbeContext } from './types.js'

/**
 * `LocalAgentProcess` do dominio com o status rico do primitivo (`spawnError`,
 * `cancelReason`): mais estreito que a porta, entao continua satisfazendo a porta.
 */
export interface LocalProcessHandle extends LocalAgentProcess {
  exit(): Promise<ExitStatus>
}

class LocalProcess implements LocalProcessHandle {
  readonly #inner: RunningProcess

  constructor(inner: RunningProcess) {
    this.#inner = inner
  }

  get handle(): string {
    return this.#inner.handle
  }

  get pid(): number | null {
    return this.#inner.pid
  }

  get cwd(): string {
    return this.#inner.cwd
  }

  get startedAt(): Date {
    return this.#inner.startedAt
  }

  get stdout(): AsyncIterable<string> {
    return this.#inner.stdout()
  }

  get stderr(): AsyncIterable<string> {
    return this.#inner.stderr()
  }

  exit(): Promise<ExitStatus> {
    return this.#inner.exit()
  }

  cancel(reason: string): Promise<void> {
    return this.#inner.cancel(reason)
  }
}

/**
 * `LocalAgentRuntime` sobre processos locais (ADR-0012). Nao conhece Mission, Task nem
 * Attempt; nao le nem injeta credencial (P17). O ambiente do filho e exatamente
 * `opts.env` — a allowlist ja montada pelo chamador.
 */
export class NodeLocalAgentRuntime implements LocalAgentRuntime {
  readonly #deps: LocalAgentRuntimeDeps

  constructor(deps: LocalAgentRuntimeDeps = {}) {
    this.#deps = deps
  }

  probe(spec: LocalAgentSpec, ctx: ProbeContext = {}): Promise<ProviderHealth> {
    return probeLocalAgent(spec, ctx, this.#deps)
  }

  async spawn(spec: LocalAgentSpec, opts: SpawnOptions): Promise<LocalProcessHandle> {
    await this.#assertWorktree(spec, opts.cwd)
    const command = await this.#resolveCommand(spec, opts)
    const running = spawnStreaming(
      {
        command,
        args: [...spec.args],
        cwd: opts.cwd,
        // Nada e acrescentado aqui: o que o chamador nao listou, o agente nao ve (P17).
        env: { ...opts.env },
        timeoutMs: opts.timeoutMs,
        stdin: opts.stdin,
      },
      this.#deps.processDeps,
    )
    return new LocalProcess(running)
  }

  /** I11: cwd obrigatorio, absoluto e existente — a worktree da tentativa. */
  async #assertWorktree(spec: LocalAgentSpec, cwd: unknown): Promise<void> {
    if (typeof cwd !== 'string' || cwd.trim().length === 0) {
      throw new WorkspaceCwdError(
        spec.providerId,
        typeof cwd === 'string' ? cwd : '',
        'cwd e obrigatorio: o processo do agente inicia na worktree da tentativa (I11)',
      )
    }
    if (!isAbsolute(cwd)) {
      throw new WorkspaceCwdError(
        spec.providerId,
        cwd,
        'cwd deve ser caminho absoluto da worktree da tentativa (I11)',
      )
    }
    const exists = await this.#isDirectory(cwd).catch((error: unknown) => {
      throw new WorkspaceCwdError(
        spec.providerId,
        cwd,
        `cwd nao pode ser inspecionado: ${describeError(error)}`,
      )
    })
    if (!exists) {
      throw new WorkspaceCwdError(spec.providerId, cwd, 'cwd nao existe ou nao e um diretorio')
    }
  }

  #isDirectory(candidate: string): Promise<boolean> {
    return (this.#deps.isDirectory ?? defaultIsDirectory)(candidate)
  }

  /**
   * Resolve o binario antes de iniciar: ausente vira `PROVIDER_UNAVAILABLE` explicito, em
   * vez de um exit code enigmatico. Resolucao `unknown` nao vira recusa — deixamos o
   * sistema operacional decidir e o status do processo relatar.
   */
  async #resolveCommand(spec: LocalAgentSpec, opts: SpawnOptions): Promise<string> {
    const resolution = await resolveExecutable(spec.executable, {
      platform: this.#deps.platform,
      pathEnv: opts.env.PATH ?? this.#deps.pathEnv ?? nodeProcess.env.PATH,
      pathExt: this.#deps.pathExt,
      isExecutableFile: this.#deps.isExecutableFile,
    })
    if (resolution.status === 'not-found') {
      throw new ProviderUnavailableError(spec.providerId, resolution.detail)
    }
    return resolution.status === 'found' ? resolution.path : spec.executable
  }
}

export function createLocalAgentRuntime(deps: LocalAgentRuntimeDeps = {}): NodeLocalAgentRuntime {
  return new NodeLocalAgentRuntime(deps)
}
