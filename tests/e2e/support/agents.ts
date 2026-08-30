import type {
  AgentHandle,
  Assignment,
  DispatchContext,
  ProviderCapabilities,
  ProviderHealth,
  ProviderId,
} from '@agentic/domain'
import type { MockScriptStep, ProviderFactory, ProviderFactoryInput } from '@agentic/providers'
import { MockAgentProvider } from '@agentic/providers'
import { ENTREGAS } from './entregas.js'

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

/** Contabilidade INDEPENDENTE do control plane: quantos agentes ficaram vivos ao mesmo tempo. */
export class ConcurrencyProbe {
  readonly #active = new Map<string, number>()
  readonly #max = new Map<string, number>()
  readonly #waiters: Array<{ readonly need: number; readonly resolve: () => void }> = []
  #globalActive = 0
  #globalMax = 0
  #rendezvous: { readonly need: number; readonly timeoutMs: number } | undefined

  /**
   * Sem encontro marcado, "duas tasks em paralelo" vira corrida contra o relogio: sob carga
   * a primeira tentativa termina antes de a segunda comecar e o teste falha por acidente.
   * Com o encontro, o agente espera ate haver `need` agentes vivos — se o orquestrador
   * despachar em paralelo, a sobreposicao e garantida; se ele SERIALIZAR, ninguem chega ao
   * encontro, a espera expira e a assercao reprova. O teste fica mais duro, nao mais frouxo.
   */
  expectConcurrent(need: number, timeoutMs = 10_000): void {
    this.#rendezvous = { need, timeoutMs }
  }

  /**
   * Resolve quando houver agentes suficientes vivos, ou quando a espera expirar.
   *
   * O encontro e de UMA vez so: assim que acontece (ou expira), ele se desarma. Sem isso
   * toda task solitaria — a ultima do DAG, por exemplo — pagaria a espera inteira atras de
   * um par que nunca vem.
   */
  async meet(): Promise<void> {
    const target = this.#rendezvous
    if (target === undefined) return
    if (this.#globalActive >= target.need) {
      this.#rendezvous = undefined
      return
    }
    await new Promise<void>((resolve) => {
      const waiter = { need: target.need, resolve }
      this.#waiters.push(waiter)
      const timer = setTimeout(() => {
        const at = this.#waiters.indexOf(waiter)
        if (at !== -1) this.#waiters.splice(at, 1)
        resolve()
      }, target.timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    this.#rendezvous = undefined
  }

  enter(providerId: string): void {
    const active = (this.#active.get(providerId) ?? 0) + 1
    this.#active.set(providerId, active)
    this.#max.set(providerId, Math.max(this.#max.get(providerId) ?? 0, active))
    this.#globalActive += 1
    this.#globalMax = Math.max(this.#globalMax, this.#globalActive)
    for (let i = this.#waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.#waiters[i]
      if (waiter !== undefined && this.#globalActive >= waiter.need) {
        this.#waiters.splice(i, 1)
        waiter.resolve()
      }
    }
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

/**
 * Roteia cada despacho para um `MockAgentProvider` novo, com o passo escolhido pelo trio
 * (task, tentativa, papel). Nao ha CLI, rede nem quota — o comportamento continua sendo o
 * do provider mock; a suite so consegue variar o roteiro entre tentativas.
 */
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
    return this.#base
      .health()
      .then((health) => ({ ...health, running: usage.running, capacity: usage.capacity }))
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
      // Espera o encontro ANTES de deixar o agente trabalhar: garante sobreposicao real
      // quando o despacho e paralelo, sem depender da velocidade da maquina.
      await this.#probe?.meet()
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

export function pass(
  summary: string,
  files: Readonly<Record<string, string>> = {},
  delayMs?: number,
): MockScriptStep {
  return {
    status: 'completed',
    claims: { summary, reportedFiles: Object.keys(files) },
    writeFiles: files,
    ...(delayMs === undefined ? {} : { delayMs }),
  }
}

export function review(
  verdict: 'PASS' | 'FAIL' | 'ESCALATE',
  detail = 'diff e gate conferidos na worktree da tentativa',
): MockScriptStep {
  return { status: 'completed', claims: { summary: `VERDICT: ${verdict}`, detail } }
}

/**
 * Espera curta no executor: torna a sobreposicao entre tasks concorrentes observavel nos
 * intervalos gravados, sem depender de o gate demorar.
 */
export const EXECUTE_DELAY_MS = 40

/** Roteiro padrao da EXEMPLO-001: entrega o que a task declarou tocar e aprova na revisao. */
export const missionStep: StepFn = (context) => {
  if (context.kind === 'review') return review('PASS')
  const files = ENTREGAS[context.taskId] ?? {}
  return pass(
    `${context.taskId}: ${Object.keys(files).join(', ')} entregue(s)`,
    files,
    EXECUTE_DELAY_MS,
  )
}
