import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve as resolvePath, sep } from 'node:path'
import {
  isDirectory,
  ProviderNotReadyError,
  ProviderUnavailableError,
  WorkspaceCwdError,
} from '@agentic/agent-runtime'
import type {
  AgentClaims,
  AgentHandle,
  AgentLogEvent,
  AgentOutcome,
  AgentOutcomeStatus,
  AgentRole,
  AgentRunStatus,
  Assignment,
  DispatchContext,
  ProviderCapabilities,
  ProviderHealth,
  ProviderId,
  Usage,
} from '@agentic/domain'
import { providerId as toProviderId } from '@agentic/domain'
import { buildAssignmentPrompt } from './assignment-prompt.js'
import type { CapacityBookLike } from './capacity.js'
import { slotFor } from './capacity.js'
import { describeUnknownError, ProviderAtCapacityError } from './errors.js'
import { AgentLogRecorder } from './logs.js'
import { logsRefFor, runStatusFor } from './outcome.js'
import type { HealthCheckedAgentProvider } from './provider.js'

export const MOCK_PROVIDER_ID = 'mock'
export const MOCK_VERSION = '1.0.0-mock'
/** Chave usada quando o roteiro nao tem entrada para a task. */
export const MOCK_DEFAULT_KEY = 'default'
/** Substituido pelo caminho da worktree no conteudo de `writeFiles`. */
export const MOCK_CWD_TOKEN = '{{cwd}}'

export type MockStartFailure = 'PROVIDER_UNAVAILABLE' | 'PROVIDER_NOT_READY'

/**
 * Um passo do roteiro. Descreve o que o agente de mentira faz — nunca o que o control
 * plane conclui: `status` vira `AgentOutcome.status`, `claims` continua sendo relato.
 */
export interface MockScriptStep {
  readonly status: AgentOutcomeStatus
  readonly claims: AgentClaims
  /** Espera antes de terminar. `delayMs >= ctx.timeoutMs` vira timeout de verdade. */
  readonly delayMs?: number
  /** Caminhos relativos a worktree. `{{cwd}}` no conteudo vira o caminho absoluto dela. */
  readonly writeFiles?: Readonly<Record<string, string>>
  readonly stdout?: readonly string[]
  readonly stderr?: readonly string[]
  readonly usage?: Usage
  /** Recusa no `start`, antes de qualquer trabalho: falha de ambiente, nao do agente. */
  readonly failWith?: MockStartFailure
}

/** Roteiro por `taskId`, com fallback em `default`. */
export type MockScript = Readonly<Record<string, MockScriptStep>>

export interface MockAgentProviderOptions {
  readonly id?: ProviderId
  readonly script?: MockScript
  readonly capacity?: CapacityBookLike
  readonly roles?: readonly AgentRole[]
  /** Simula binario ausente: `health.installed = false` e `start` recusa. */
  readonly installed?: boolean
  /** Simula sessao nao autenticada: `health.ready = false` e `start` recusa. */
  readonly ready?: boolean | 'unknown'
  readonly now?: () => number
}

/**
 * Sem roteiro nenhum nao ha o que ensaiar — e fingir sucesso era o pior desfecho possivel.
 *
 * O `completed` de antes fazia a tentativa cair em `NO_CHANGES: a tentativa nao alterou
 * nenhum arquivo` tres vezes seguidas ate `BLOCKED`, sem que nada na mensagem ligasse a
 * causa ao agente de ensaio. Reprovar dizendo o nome do problema custa uma tentativa e
 * economiza a investigacao inteira. O status continua vindo do provider, nunca do relato.
 */
export const MOCK_FALLBACK_STEP: MockScriptStep = {
  status: 'failed',
  claims: {
    summary:
      'agente de ensaio sem roteiro: nao escreve codigo. Troque providers.default por uma CLI real',
  },
}

export interface PlannedWrite {
  readonly absolute: string
  readonly content: string
}

/**
 * Agente deterministico: sem processo, sem rede, sem quota. Mesmo roteiro e mesmo
 * workspace produzem exatamente o mesmo `AgentOutcome`, quantas vezes se repita — e o
 * que torna o gate de qualidade do proprio produto viavel (ARCHITECTURE 8).
 */
export class MockAgentProvider implements HealthCheckedAgentProvider {
  readonly id: ProviderId
  readonly #script: MockScript
  readonly #capacity: CapacityBookLike | undefined
  readonly #capabilities: ProviderCapabilities
  readonly #installed: boolean
  readonly #ready: boolean | 'unknown'
  readonly #now: () => number

  constructor(options: MockAgentProviderOptions = {}) {
    this.id = options.id ?? toProviderId(MOCK_PROVIDER_ID)
    this.#script = options.script ?? {}
    this.#capacity = options.capacity
    this.#installed = options.installed ?? true
    this.#ready = options.ready ?? true
    this.#now = options.now ?? Date.now
    this.#capabilities = {
      roles: options.roles ?? ['executor', 'reviewer'],
      streaming: true,
      cancellation: true,
      // In-process: prontidao e observavel de verdade, entao declarar suporte e honesto.
      readinessProbe: 'supported',
      // Declarado a partir do roteiro: o mock so relata uso se o roteiro relatar.
      reportsUsage: Object.values(this.#script).some((step) => step.usage !== undefined),
    }
  }

  capabilities(): ProviderCapabilities {
    return this.#capabilities
  }

  health(): Promise<ProviderHealth> {
    const usage = this.#capacity?.usage(this.id)
    const detail = this.#installed
      ? `agente in-process; prontidao ${String(this.#ready)}`
      : 'agente in-process marcado como ausente pelo roteiro'
    return Promise.resolve({
      providerId: this.id,
      installed: this.#installed,
      ready: this.#installed ? this.#ready : false,
      version: this.#installed ? MOCK_VERSION : 'unknown',
      detail,
      probedAt: new Date(this.#now()),
      running: usage?.running ?? 0,
      capacity: usage?.capacity ?? null,
    })
  }

  /** Passo efetivo para a task: entrada propria, senao `default`, senao o fallback. */
  step(taskId: string): MockScriptStep {
    return this.#script[taskId] ?? this.#script[MOCK_DEFAULT_KEY] ?? MOCK_FALLBACK_STEP
  }

  async start(assignment: Assignment, ctx: DispatchContext): Promise<AgentHandle> {
    const slot = slotFor(assignment.kind)
    this.#acquire(slot)
    try {
      await this.#assertWorktree(ctx.workspace.path)
      this.#assertReady()
      const step = this.step(assignment.taskId)
      this.#assertStepReady(step)
      const writes = planWrites(step, ctx.workspace.path)
      // O prompt e montado sempre: o mock exercita a mesma traducao dos adapters reais.
      const prompt = buildAssignmentPrompt(assignment)
      return new MockAgentHandle({
        providerId: this.id,
        assignment,
        timeoutMs: ctx.timeoutMs,
        step,
        writes,
        promptChars: prompt.text.length,
        now: this.#now,
        release: () => this.#release(slot),
      })
    } catch (error) {
      this.#release(slot)
      throw error
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

  #release(slot: AgentRole): void {
    this.#capacity?.release(this.id, slot)
  }

  #assertReady(): void {
    if (!this.#installed) {
      throw new ProviderUnavailableError(this.id, 'roteiro declara o agente como ausente')
    }
    if (this.#ready === false) {
      throw new ProviderNotReadyError(this.id, 'roteiro declara a sessao como nao autenticada')
    }
  }

  #assertStepReady(step: MockScriptStep): void {
    if (step.failWith === 'PROVIDER_UNAVAILABLE') {
      throw new ProviderUnavailableError(this.id, 'roteiro: provider indisponivel nesta task')
    }
    if (step.failWith === 'PROVIDER_NOT_READY') {
      throw new ProviderNotReadyError(this.id, 'roteiro: provider nao pronto nesta task')
    }
  }

  /** I11: mesmo sem processo, o mock so trabalha dentro da worktree da tentativa. */
  async #assertWorktree(cwd: string): Promise<void> {
    if (typeof cwd !== 'string' || cwd.trim().length === 0 || !isAbsolute(cwd)) {
      throw new WorkspaceCwdError(this.id, cwd, 'cwd deve ser o caminho absoluto da worktree (I11)')
    }
    if (!(await isDirectory(cwd))) {
      throw new WorkspaceCwdError(this.id, cwd, 'cwd nao existe ou nao e um diretorio')
    }
  }
}

export function planWrites(step: MockScriptStep, workspacePath: string): PlannedWrite[] {
  const base = resolvePath(workspacePath)
  const out: PlannedWrite[] = []
  for (const [relative, content] of Object.entries(step.writeFiles ?? {})) {
    if (isAbsolute(relative)) {
      throw new Error(`roteiro invalido: writeFiles nao aceita caminho absoluto (${relative})`)
    }
    const absolute = resolvePath(base, relative)
    if (absolute !== base && !absolute.startsWith(base + sep)) {
      throw new Error(`roteiro invalido: writeFiles sai da worktree (${relative})`)
    }
    out.push({ absolute, content: content.split(MOCK_CWD_TOKEN).join(base) })
  }
  return out
}

interface MockHandleInput {
  readonly providerId: ProviderId
  readonly assignment: Assignment
  readonly timeoutMs: number
  readonly step: MockScriptStep
  readonly writes: readonly PlannedWrite[]
  readonly promptChars: number
  readonly now: () => number
  readonly release: () => void
}

class MockAgentHandle implements AgentHandle {
  readonly ref: string
  readonly #input: MockHandleInput
  readonly #recorder: AgentLogRecorder
  readonly #result: Promise<AgentOutcome>
  #status: AgentRunStatus = 'running'
  #timer: ReturnType<typeof setTimeout> | null = null
  #finish: ((status: AgentOutcomeStatus) => void) | null = null
  #cancelReason: string | null = null

  constructor(input: MockHandleInput) {
    this.#input = input
    this.ref = `${input.providerId}:${input.assignment.attemptId}`
    this.#recorder = new AgentLogRecorder(input.now)
    this.#recorder.pushAll('stdout', input.step.stdout ?? [])
    this.#recorder.pushAll('stderr', input.step.stderr ?? [])

    const delayMs = input.step.delayMs ?? 0
    // Espera maior que o limite da tentativa e timeout de verdade, nao o status do roteiro.
    const timedOut = delayMs > 0 && delayMs >= input.timeoutMs
    const waitMs = timedOut ? input.timeoutMs : delayMs
    const planned: AgentOutcomeStatus = timedOut ? 'timeout' : input.step.status

    this.#result = new Promise<AgentOutcomeStatus>((resolve) => {
      this.#finish = (status) => {
        if (this.#timer !== null) clearTimeout(this.#timer)
        this.#timer = null
        this.#finish = null
        resolve(status)
      }
      this.#timer = setTimeout(() => this.#finish?.(planned), waitMs)
    }).then((status) => this.#settle(status))
  }

  status(): AgentRunStatus {
    return this.#status
  }

  cancel(reason: string): Promise<void> {
    if (this.#finish !== null) {
      this.#cancelReason = reason
      this.#recorder.push('stderr', `cancelado: ${reason}`)
      this.#finish('cancelled')
    }
    return this.#result.then(() => undefined)
  }

  result(): Promise<AgentOutcome> {
    return this.#result
  }

  logs(): AsyncIterable<AgentLogEvent> {
    return this.#recorder.stream()
  }

  async #settle(status: AgentOutcomeStatus): Promise<AgentOutcome> {
    let effective = status
    let writeFailure: string | null = null
    if (status === 'completed' || status === 'failed') {
      try {
        await this.#write()
      } catch (error) {
        effective = 'failed'
        writeFailure = describeUnknownError(error)
      }
    }
    this.#recorder.close()
    this.#status = runStatusFor(effective)
    this.#input.release()
    const outcome: AgentOutcome = {
      status: effective,
      claims: this.#claims(effective, writeFailure),
      logsRef: logsRefFor(this.#input.providerId, this.#input.assignment),
      // In-process: nao ha grupo de processos a assentar.
      groupTerminated: true,
    }
    const usage = this.#input.step.usage
    return usage === undefined ? outcome : { ...outcome, usage }
  }

  #claims(status: AgentOutcomeStatus, writeFailure: string | null): AgentClaims {
    if (status === 'cancelled') {
      return { summary: `cancelado antes de concluir: ${this.#cancelReason ?? 'sem motivo'}` }
    }
    if (writeFailure !== null) {
      return { summary: `mock nao conseguiu escrever na worktree: ${writeFailure}` }
    }
    const claims = this.#input.step.claims
    if (claims.detail !== undefined) return claims
    return { ...claims, detail: `prompt de ${this.#input.promptChars} caracteres` }
  }

  async #write(): Promise<void> {
    for (const write of this.#input.writes) {
      await mkdir(dirname(write.absolute), { recursive: true })
      await writeFile(write.absolute, write.content, 'utf8')
    }
  }
}
