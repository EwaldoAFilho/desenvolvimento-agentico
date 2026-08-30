import type { ProbeContext } from '@agentic/agent-runtime'
import {
  createLocalAgentRuntime,
  ProviderNotReadyError,
  ProviderUnavailableError,
} from '@agentic/agent-runtime'
import type {
  AgentHandle,
  AgentLogEvent,
  AgentOutcome,
  AgentRole,
  AgentRunStatus,
  Assignment,
  DispatchContext,
  ExitStatus,
  LocalAgentProcess,
  LocalAgentSpec,
  ProviderCapabilities,
  ProviderHealth,
  ProviderId,
  SpawnOptions,
} from '@agentic/domain'
import { providerId as toProviderId } from '@agentic/domain'
import { assignmentPromptText } from './assignment-prompt.js'
import type { CapacityBookLike } from './capacity.js'
import { slotFor } from './capacity.js'
import { InvalidProviderDescriptorError, ProviderAtCapacityError } from './errors.js'
import { AgentLogRecorder, pumpInto } from './logs.js'
import { claimsFromOutput, logsRefFor, outcomeStatusFromExit, runStatusFor } from './outcome.js'
import type { HealthCheckedAgentProvider } from './provider.js'

/**
 * O que este adapter usa do runtime local. Mais estreito que a porta do dominio porque
 * precisa do `ProbeContext` — e o runtime real satisfaz esta forma.
 */
export interface LocalCliRuntime {
  probe(spec: LocalAgentSpec, ctx?: ProbeContext): Promise<ProviderHealth>
  spawn(spec: LocalAgentSpec, opts: SpawnOptions): Promise<LocalAgentProcess>
}

/**
 * Tudo que distingue uma CLI da outra. Os adapters concretos sao este descritor mais um
 * nome — e por isso "adicionar provider" e tarefa mecanica (ADR-0010).
 */
export interface LocalCliDescriptor {
  readonly id: string
  readonly command: string
  readonly capabilities: ProviderCapabilities
  readonly versionArgs: readonly string[]
  /** So existe quando `capabilities.readinessProbe === 'supported'`. */
  readonly readinessArgs?: readonly string[]
  /** Argumentos do modo nao interativo, antes do texto do assignment. */
  readonly runArgs: readonly string[]
}

export interface LocalCliProviderOptions {
  readonly id?: ProviderId
  readonly command?: string
  readonly runtime?: LocalCliRuntime
  readonly capacity?: CapacityBookLike
  readonly roles?: readonly AgentRole[]
  readonly versionArgs?: readonly string[]
  readonly runArgs?: readonly string[]
  /** Desliga a sonda de prontidao no despacho; a sonda de `health()` continua. */
  readonly probeOnStart?: boolean
  readonly now?: () => number
}

/**
 * Adapter de CLI local (ADR-0009): o agente e um programa que o usuario ja instalou e
 * autenticou. Nao lemos, nao exigimos e nao injetamos credencial — o ambiente do filho e
 * exatamente `ctx.env`, a allowlist montada pelo control plane (P17).
 */
export class LocalCliAgentProvider implements HealthCheckedAgentProvider {
  readonly id: ProviderId
  readonly command: string
  readonly #capabilities: ProviderCapabilities
  readonly #versionArgs: readonly string[]
  readonly #readinessArgs: readonly string[] | undefined
  readonly #runArgs: readonly string[]
  readonly #runtime: LocalCliRuntime
  readonly #capacity: CapacityBookLike | undefined
  readonly #probeOnStart: boolean
  readonly #now: () => number

  constructor(descriptor: LocalCliDescriptor, options: LocalCliProviderOptions = {}) {
    this.id = options.id ?? toProviderId(descriptor.id)
    this.command = options.command ?? descriptor.command
    this.#capabilities = {
      ...descriptor.capabilities,
      roles: options.roles ?? descriptor.capabilities.roles,
    }
    this.#versionArgs = options.versionArgs ?? descriptor.versionArgs
    this.#runArgs = options.runArgs ?? descriptor.runArgs
    this.#runtime = options.runtime ?? createLocalAgentRuntime()
    this.#capacity = options.capacity
    this.#probeOnStart = options.probeOnStart ?? true
    this.#now = options.now ?? Date.now

    if (this.#capabilities.readinessProbe === 'supported') {
      const args = descriptor.readinessArgs
      if (args === undefined || args.length === 0) {
        throw new InvalidProviderDescriptorError(
          descriptor.id,
          "readinessProbe 'supported' exige readinessArgs; declarar suporte inexistente e proibido",
        )
      }
      this.#readinessArgs = args
    } else {
      // Prontidao declarada como nao observavel: a sonda nao existe e nao ha como
      // fabrica-la depois. `ready` cai em 'unknown' por construcao (ADR-0010).
      this.#readinessArgs = undefined
    }
  }

  capabilities(): ProviderCapabilities {
    return this.#capabilities
  }

  /** Spec sem o prompt: usada pela sonda de saude. */
  probeSpec(): LocalAgentSpec {
    const spec: LocalAgentSpec = {
      providerId: this.id,
      executable: this.command,
      args: [],
      versionArgs: this.#versionArgs,
    }
    return this.#readinessArgs === undefined
      ? spec
      : { ...spec, readinessArgs: this.#readinessArgs }
  }

  health(): Promise<ProviderHealth> {
    return this.#runtime.probe(this.probeSpec(), this.#probeContext())
  }

  async start(assignment: Assignment, ctx: DispatchContext): Promise<AgentHandle> {
    const slot = slotFor(assignment.kind)
    this.#acquire(slot)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.#capacity?.release(this.id, slot)
    }
    try {
      await this.#assertReady()
      const prompt = assignmentPromptText(assignment)
      const spec: LocalAgentSpec = {
        ...this.probeSpec(),
        args: [...this.#runArgs, prompt],
      }
      const proc = await this.#runtime.spawn(spec, {
        // I11: sempre a worktree da tentativa.
        cwd: ctx.workspace.path,
        // P17: exatamente a allowlist recebida, sem acrescimo nosso.
        env: ctx.env,
        timeoutMs: ctx.timeoutMs,
      })
      return new LocalCliAgentHandle(proc, this.id, assignment, this.#now, release)
    } catch (error) {
      release()
      throw error
    }
  }

  #probeContext(): ProbeContext {
    const usage = this.#capacity?.usage(this.id)
    return {
      capabilities: this.#capabilities,
      running: usage?.running ?? 0,
      capacity: usage?.capacity ?? null,
    }
  }

  /**
   * CLI ausente vira `PROVIDER_UNAVAILABLE`; presente mas com sonda reprovando vira
   * `PROVIDER_NOT_READY`. Sonda `unknown` nao recusa nada: prontidao indeterminada nao e
   * prova de nao-prontidao, e a verdade aparece no despacho (ARCHITECTURE 3.6.1).
   */
  async #assertReady(): Promise<void> {
    if (!this.#probeOnStart) return
    if (this.#capabilities.readinessProbe === 'unsupported') return
    const health = await this.#runtime.probe(this.probeSpec(), this.#probeContext())
    if (health.installed === false) {
      throw new ProviderUnavailableError(this.id, health.detail)
    }
    if (health.ready === false) {
      throw new ProviderNotReadyError(this.id, health.detail)
    }
  }

  #acquire(slot: AgentRole): void {
    const book = this.#capacity
    if (book === undefined) return
    const result = book.acquire(this.id, slot)
    if (!result.ok) {
      throw new ProviderAtCapacityError(
        this.id,
        result.reason,
        result.running,
        result.capacity,
        result.detail,
      )
    }
  }
}

class LocalCliAgentHandle implements AgentHandle {
  readonly ref: string
  readonly #proc: LocalAgentProcess
  readonly #recorder: AgentLogRecorder
  readonly #result: Promise<AgentOutcome>
  #status: AgentRunStatus = 'running'

  constructor(
    proc: LocalAgentProcess,
    providerId: ProviderId,
    assignment: Assignment,
    now: () => number,
    release: () => void,
  ) {
    this.#proc = proc
    this.ref = proc.handle
    this.#recorder = new AgentLogRecorder(now)
    const pumps = Promise.all([
      pumpInto(this.#recorder, 'stdout', proc.stdout),
      pumpInto(this.#recorder, 'stderr', proc.stderr),
    ])
    this.#result = this.#settle(providerId, assignment, pumps, release)
  }

  status(): AgentRunStatus {
    return this.#status
  }

  cancel(reason: string): Promise<void> {
    return this.#proc.cancel(reason).then(() => undefined)
  }

  result(): Promise<AgentOutcome> {
    return this.#result
  }

  logs(): AsyncIterable<AgentLogEvent> {
    return this.#recorder.stream()
  }

  async #settle(
    providerId: ProviderId,
    assignment: Assignment,
    pumps: Promise<unknown>,
    release: () => void,
  ): Promise<AgentOutcome> {
    let exit: ExitStatus
    try {
      const [status] = await Promise.all([this.#proc.exit(), pumps])
      exit = status
    } finally {
      this.#recorder.close()
      release()
    }
    const status = outcomeStatusFromExit(exit)
    this.#status = runStatusFor(status)
    return {
      status,
      claims: claimsFromOutput(this.#recorder.text('stdout'), this.#recorder.text('stderr'), exit),
      logsRef: logsRefFor(providerId, assignment),
    }
  }
}
