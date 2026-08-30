import type {
  AgentHandle,
  AgentLogEvent,
  AgentOutcome,
  AgentRole,
  AgentRunStatus,
  Assignment,
  DispatchContext,
  ProviderCapabilities,
  ProviderHealth,
  ProviderId,
} from '@agentic/domain'
import {
  MockAgentProvider,
  type MockScriptStep,
  type ProviderFactory,
  type ProviderFactoryInput,
} from '@agentic/providers'

export interface StepContext {
  readonly taskId: string
  readonly attemptNumber: number
  readonly kind: 'execute' | 'review'
  readonly providerId: ProviderId
  readonly workspacePath: string
}

export type StepFn = (context: StepContext) => MockScriptStep

const ATTEMPT = /-a(\d+)-/

export function attemptNumberOf(attemptId: string): number {
  const match = ATTEMPT.exec(attemptId)
  const parsed = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10)
  return Number.isInteger(parsed) ? parsed : 1
}

/**
 * Roteia cada despacho para um `MockAgentProvider` novo, com o passo escolhido pelo
 * (task, tentativa, papel). Nao ha CLI, rede nem quota: o comportamento continua sendo o
 * do provider mock, so que a suite consegue variar o roteiro entre tentativas.
 */
/** Contabilidade independente do control plane: quantos agentes ficaram vivos ao mesmo tempo. */
export class ConcurrencyProbe {
  readonly #active = new Map<string, number>()
  readonly #max = new Map<string, number>()
  #globalActive = 0
  #globalMax = 0

  enter(providerId: string): void {
    const active = (this.#active.get(providerId) ?? 0) + 1
    this.#active.set(providerId, active)
    this.#max.set(providerId, Math.max(this.#max.get(providerId) ?? 0, active))
    this.#globalActive += 1
    this.#globalMax = Math.max(this.#globalMax, this.#globalActive)
  }

  leave(providerId: string): void {
    this.#active.set(providerId, Math.max(0, (this.#active.get(providerId) ?? 0) - 1))
    this.#globalActive = Math.max(0, this.#globalActive - 1)
  }

  get max(): number {
    return this.#globalMax
  }

  maxOf(providerId: string): number {
    return this.#max.get(providerId) ?? 0
  }
}

export class ScriptedAgentProvider {
  readonly id: ProviderId
  readonly #input: ProviderFactoryInput
  readonly #step: StepFn
  readonly #base: MockAgentProvider
  readonly #probe: ConcurrencyProbe | undefined

  constructor(input: ProviderFactoryInput, step: StepFn, probe?: ConcurrencyProbe) {
    this.id = input.id
    this.#input = input
    this.#step = step
    this.#probe = probe
    this.#base = new MockAgentProvider({ id: input.id, roles: input.config.roles })
  }

  capabilities(): ProviderCapabilities {
    return this.#base.capabilities()
  }

  health(): Promise<ProviderHealth> {
    const usage = this.#input.capacity.usage(this.id)
    return this.#base.health().then((health) => ({
      ...health,
      running: usage.running,
      capacity: usage.capacity,
    }))
  }

  async start(assignment: Assignment, ctx: DispatchContext): Promise<AgentHandle> {
    const step = this.#step({
      taskId: assignment.taskId,
      attemptNumber: attemptNumberOf(assignment.attemptId),
      kind: assignment.kind,
      providerId: this.id,
      workspacePath: assignment.workspacePath,
    })
    const provider = new MockAgentProvider({
      id: this.id,
      capacity: this.#input.capacity,
      roles: this.#input.config.roles,
      script: { default: step },
    })
    this.#probe?.enter(this.id)
    let handle: AgentHandle
    try {
      handle = await provider.start(assignment, ctx)
    } catch (error) {
      this.#probe?.leave(this.id)
      throw error
    }
    void handle.result().then(
      () => this.#probe?.leave(this.id),
      () => this.#probe?.leave(this.id),
    )
    return handle
  }
}

export function scriptedFactory(step: StepFn, probe?: ConcurrencyProbe): ProviderFactory {
  return (input) => new ScriptedAgentProvider(input, step, probe)
}

export function pass(summary: string, files: Readonly<Record<string, string>> = {}): MockScriptStep {
  return { status: 'completed', claims: { summary }, writeFiles: files }
}

export function review(verdict: 'PASS' | 'FAIL' | 'ESCALATE', detail = 'analise da evidencia'): MockScriptStep {
  return {
    status: 'completed',
    claims: { summary: `VERDICT: ${verdict}`, detail },
  }
}

/**
 * Handle que morre sem desfecho: `result()` rejeita. E o que acontece quando o processo do
 * agente e arrancado e o adapter nao consegue traduzir o fim em `AgentOutcome`. O contrato
 * da porta permite; o orquestrador nao pode perder a tentativa por causa disso.
 */
class BrokenHandle implements AgentHandle {
  readonly ref: string
  readonly #detail: string
  readonly #release: () => void

  constructor(ref: string, detail: string, release: () => void) {
    this.ref = ref
    this.#detail = detail
    this.#release = release
  }

  status(): AgentRunStatus {
    return 'failed'
  }

  cancel(): Promise<void> {
    return Promise.resolve()
  }

  result(): Promise<AgentOutcome> {
    // Vaga devolvida como um adapter real faria no `finally`; o que falta e o desfecho.
    this.#release()
    return Promise.reject(new Error(this.#detail))
  }

  logs(): AsyncIterable<AgentLogEvent> {
    return { [Symbol.asyncIterator]: async function* () {} }
  }
}

/** Provider que entrega um handle quebrado no papel escolhido e roteiro normal no outro. */
export class BrokenHandleProvider {
  readonly id: ProviderId
  readonly #input: ProviderFactoryInput
  readonly #breakOn: 'execute' | 'review'
  readonly #inner: ScriptedAgentProvider

  constructor(input: ProviderFactoryInput, breakOn: 'execute' | 'review', step: StepFn) {
    this.id = input.id
    this.#input = input
    this.#breakOn = breakOn
    this.#inner = new ScriptedAgentProvider(input, step)
  }

  capabilities(): ProviderCapabilities {
    return this.#inner.capabilities()
  }

  health(): Promise<ProviderHealth> {
    return this.#inner.health()
  }

  start(assignment: Assignment, ctx: DispatchContext): Promise<AgentHandle> {
    if (assignment.kind !== this.#breakOn) return this.#inner.start(assignment, ctx)
    const slot: AgentRole = assignment.kind === 'review' ? 'reviewer' : 'executor'
    this.#input.capacity.acquire(this.id, slot)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.#input.capacity.release(this.id, slot)
    }
    return Promise.resolve(
      new BrokenHandle(
        `${this.id}:${assignment.attemptId}`,
        `processo do agente desapareceu sem desfecho (${assignment.kind})`,
        release,
      ),
    )
  }
}

export function brokenHandleFactory(
  breakOn: 'execute' | 'review',
  step: StepFn = () => pass('nunca usado'),
): ProviderFactory {
  return (input) => new BrokenHandleProvider(input, breakOn, step)
}
