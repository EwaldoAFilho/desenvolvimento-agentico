import {
  type AgentHandle,
  type AgentIdentity,
  type AgentOutcome,
  type Attempt,
  type AttemptId,
  applyRunTransition,
  applyTransition,
  type Blockage,
  checkRunCompletion,
  consumesAttempt,
  type DependencyState,
  type DomainEvent,
  type DomainEventInput,
  type EventPayloadMap,
  type EventType,
  type EvidenceRef,
  type FailureCode,
  type FailureReason,
  type GateExecution,
  type GateStatus,
  type IntegrationResult,
  InvalidTransitionError,
  isDone,
  isRetryable,
  isRunDeadlocked,
  isRunReadyToVerify,
  isTerminalRunStatus,
  type Observation,
  type PathScope,
  type Review,
  type ReviewPolicy,
  type ReviewPolicyOutcome,
  type Run,
  type RunId,
  type RunStatus,
  type RunTrigger,
  resolveTaskSettings,
  type TaskId,
  type TaskRun,
  type TaskRunSnapshot,
  type TaskSpec,
  type TaskStatus,
  type TaskTrigger,
  attemptId as toAttemptId,
  gateId as toGateId,
  taskRunId as toTaskRunId,
  type Workspace,
  type WorkspaceRef,
} from '@agentic/domain'
import type { LockRow } from '@agentic/persistence'
import type {
  ActiveLock,
  PendingReview,
  SchedulerDecision,
  SchedulerInput,
} from '../scheduler/index.js'
import { select } from '../scheduler/index.js'
import { MISSION_GATE_ARTIFACT } from './artifacts.js'
import { buildExecuteAssignment, buildReviewAssignment } from './assignment.js'
import {
  CommandRefusedError,
  describeError,
  failureReasonOf,
  RunNotFoundError,
  TaskNotFoundError,
} from './errors.js'
import { type EventContext, engineEvent, humanActor } from './events.js'
import { gateEvidence, integrationEvidence, reviewEvidence, scopeEvidence } from './evidence.js'
import { runGate } from './gate-run.js'
import { attemptDirectory, observeAttempt } from './observe.js'
import {
  ACTIVE_STATUSES,
  ATTEMPT_RESULT_OF,
  blockageFor,
  CANCELLABLE,
  DISPATCH_COOLDOWN_MS,
  delay,
  denyScopes,
  FAILED_TRIGGER,
} from './policy.js'
import type { EngineDeps } from './types.js'
import { parseReview } from './verdict.js'

type TaskTransitionReview = NonNullable<Parameters<typeof applyTransition>[2]>['review']
type TaskTransitionReviewResult = NonNullable<Parameters<typeof applyTransition>[2]>['reviewResult']

type AttemptPhase =
  | 'running'
  | 'observing'
  | 'verifying'
  | 'awaiting-review'
  | 'review'
  | 'integrating'

interface Inflight {
  attempt: Attempt
  workspace: Workspace
  spec: TaskSpec
  phase: AttemptPhase
  enforceTouches: boolean
  handle?: AgentHandle
  observation?: Observation
  gateExecution?: GateExecution
  review?: Review
  reviewer?: AgentIdentity
  policy?: ReviewPolicy
  policyOutcome?: ReviewPolicyOutcome
  reviewStartedAt?: number
}

interface TickState {
  run: Run
  readonly tasks: Map<TaskId, TaskRun>
}

interface Mutation {
  run?: Run
  taskRun?: TaskRun
  attempt?: Attempt
  gate?: GateExecution
  review?: Review
  acquireLocks?: readonly { readonly path: PathScope; readonly attemptId: AttemptId }[]
  releaseLocks?: readonly PathScope[]
  events: readonly DomainEventInput[]
}

type Message =
  | {
      readonly kind: 'observed'
      readonly attemptId: AttemptId
      readonly outcome: AgentOutcome
      readonly observation?: Observation
      readonly failure?: FailureReason
    }
  | {
      readonly kind: 'gate'
      readonly attemptId: AttemptId
      readonly execution?: GateExecution
      readonly failure?: FailureReason
    }
  | {
      readonly kind: 'review'
      readonly attemptId: AttemptId
      readonly outcome?: AgentOutcome
      readonly failure?: FailureReason
      readonly durationMs: number
    }
  | {
      readonly kind: 'integration'
      readonly attemptId: AttemptId
      readonly result?: IntegrationResult
      readonly failure?: FailureReason
    }
  | {
      readonly kind: 'mission-gate'
      readonly execution?: GateExecution
      readonly failure?: FailureReason
    }

export interface HumanCommand {
  readonly actor: string
  readonly reason?: string
}

export interface TaskCommandInput extends HumanCommand {
  readonly taskId: TaskId
}

export interface UnblockInput extends TaskCommandInput {
  readonly note: string
}

export interface DrainOptions {
  readonly maxTicks?: number
}

/** Intervalo do timer de seguranca quando o chamador nao escolhe um (ARCHITECTURE 3.3). */
export const DEFAULT_SAFETY_INTERVAL_MS = 1_000

/**
 * Loop de reconciliacao e UNICO ESCRITOR do estado do run (I7, ARCHITECTURE 3.3).
 *
 * Um `tick` faz, nesta ordem: reconcilia tentativas orfas, coleta resultados prontos,
 * aplica transicoes + eventos na mesma transacao (I1), recalcula READY, pede decisoes ao
 * scheduler, adquire locks e workspaces e despacha, e reavalia o estado derivado do run.
 *
 * Efeitos demorados (agente, gate, integracao) rodam FORA do tick e voltam pela caixa de
 * entrada; o tick e serializado, entao nunca ha duas escritas concorrentes.
 */
export class Orchestrator {
  readonly #deps: EngineDeps
  readonly #runId: RunId
  readonly #inflight = new Map<AttemptId, Inflight>()
  readonly #locks = new Map<TaskId, readonly PathScope[]>()
  readonly #retryAt = new Map<TaskId, number>()
  readonly #dispatchCooldown = new Map<TaskId, number>()
  readonly #grants = new Map<TaskId, number>()
  readonly #jobs = new Set<Promise<void>>()
  readonly #errors: unknown[] = []
  #inbox: Message[] = []
  #chain: Promise<void> = Promise.resolve()
  #missionGate: { readonly status: GateStatus; readonly executionId?: string } | undefined
  #missionGateStarted = false
  #grantsLoaded = false
  #status: RunStatus | undefined
  #dirty = false
  #tickCount = 0
  #closed = false
  #autoTick = false
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(deps: EngineDeps, runId: RunId) {
    this.#deps = deps
    this.#runId = runId
  }

  get runId(): RunId {
    return this.#runId
  }

  get status(): RunStatus | undefined {
    return this.#status
  }

  get ticks(): number {
    return this.#tickCount
  }

  /** Falhas de trabalho assincrono ficam visiveis em vez de sumirem num `catch` mudo. */
  get errors(): readonly unknown[] {
    return this.#errors
  }

  get inflightAttempts(): readonly AttemptId[] {
    return [...this.#inflight.keys()]
  }

  /** Liga o tick por evento e o timer de seguranca (ARCHITECTURE 3.3). */
  start(): void {
    this.#autoTick = true
    // Sem timer, nada acorda o loop quando o proximo passo depende do RELOGIO e nao de um
    // evento — o backoff de RETRY e o caso obvio. Por isso o default e ligado; `0` e o
    // desligamento explicito de quem dirige o loop na mao (teste).
    const interval = this.#deps.safetyIntervalMs ?? DEFAULT_SAFETY_INTERVAL_MS
    if (interval > 0 && this.#timer === undefined) {
      this.#timer = setInterval(() => {
        void this.tick()
      }, interval)
      this.#timer.unref?.()
    }
    void this.tick()
  }

  stop(): void {
    this.#autoTick = false
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }

  /**
   * Encerra o processo do control plane SEM presumir nada sobre o que estava em voo — e o
   * que o teste de recovery exercita: o estado no banco continua RUNNING e a proxima
   * abertura reconcilia.
   */
  async abandon(): Promise<void> {
    this.stop()
    this.#closed = true
    const handles = [...this.#inflight.values()].map((entry) => entry.handle)
    for (const handle of handles) {
      if (handle === undefined) continue
      await handle.cancel('control plane encerrado').catch(() => undefined)
    }
    await Promise.allSettled([...this.#jobs])
    this.#inflight.clear()
    this.#inbox = []
  }

  tick(): Promise<void> {
    return this.#enqueue(() => this.#runTick())
  }

  /** Dirige o loop ate nao haver mais trabalho pendente. Usado pela CLI e pelos testes. */
  async drain(options: DrainOptions = {}): Promise<void> {
    const max = options.maxTicks ?? 500
    for (let attempt = 0; attempt < max; attempt += 1) {
      this.#dirty = false
      await this.tick()
      if (this.#closed) return
      if (this.#status !== undefined && isTerminalRunStatus(this.#status)) return
      if (this.#inbox.length > 0) continue
      // Uma escrita pode ter destravado o proximo passo (ex.: run saiu de BLOCKED).
      if (this.#dirty) continue
      if (this.#jobs.size === 0) {
        const wait = this.#nextRetryDelay()
        if (wait === undefined) return
        await delay(wait)
        continue
      }
      await Promise.race([...this.#jobs])
    }
    throw new CommandRefusedError(`drain excedeu ${max} ticks sem estabilizar`)
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(work)
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #track(promise: Promise<unknown>): void {
    const settled = promise.then(
      () => undefined,
      (error: unknown) => {
        this.#errors.push(error)
      },
    )
    this.#jobs.add(settled)
    void settled.then(() => {
      this.#jobs.delete(settled)
    })
  }

  #push(message: Message): void {
    if (this.#closed) return
    this.#inbox.push(message)
    this.#requestTick()
  }

  /** Tick por evento: comando humano e resultado de trabalho assincrono acordam o loop. */
  #requestTick(): void {
    if (this.#autoTick && !this.#closed) void this.tick()
  }

  #nextRetryDelay(): number | undefined {
    let soonest: number | undefined
    for (const at of this.#retryAt.values()) {
      if (soonest === undefined || at < soonest) soonest = at
    }
    if (soonest === undefined) return undefined
    return Math.max(0, soonest - this.#deps.clock.now().getTime())
  }

  // ---------------------------------------------------------------- tick

  async #runTick(): Promise<void> {
    if (this.#closed) return
    this.#tickCount += 1
    const state = await this.#load()
    this.#status = state.run.status
    if (isTerminalRunStatus(state.run.status)) return
    await this.#loadGrants()

    await this.#reconcile(state)
    await this.#drainInbox(state)
    await this.#promote(state)
    await this.#dispatch(state)
    await this.#derive(state)
    this.#status = state.run.status
  }

  async #load(): Promise<TickState> {
    const run = await this.#deps.store.loadRun(this.#runId)
    if (run === undefined) throw new RunNotFoundError(this.#runId)
    const tasks = new Map<TaskId, TaskRun>()
    for (const taskRun of await this.#deps.store.loadTaskRuns(this.#runId)) {
      tasks.set(taskRun.taskId, taskRun)
    }
    return { run, tasks }
  }

  /**
   * Toda escrita passa por aqui: estado e evento na MESMA transacao (I1). Uma transacao
   * sem evento seria recusada pela unidade de trabalho da persistencia.
   */
  async #write(mutation: Mutation): Promise<void> {
    const now = this.#deps.clock.now()
    this.#dirty = true
    await this.#deps.store.withTransaction(async (uow) => {
      if (mutation.run !== undefined) await uow.saveRun(mutation.run)
      if (mutation.taskRun !== undefined) await uow.saveTaskRun(mutation.taskRun)
      if (mutation.attempt !== undefined) await uow.saveAttempt(mutation.attempt)
      if (mutation.gate !== undefined) await uow.saveGateExecution(mutation.gate)
      if (mutation.review !== undefined) await uow.saveReview(mutation.review)
      for (const lock of mutation.acquireLocks ?? []) {
        await uow.acquireLock(this.#runId, lock.path, lock.attemptId, now)
      }
      for (const path of mutation.releaseLocks ?? []) await uow.releaseLock(this.#runId, path)
      for (const event of mutation.events) await uow.appendEvent(event)
    })
  }

  #event<K extends EventType>(
    ts: Date,
    type: K,
    payload: EventPayloadMap[K],
    context: EventContext = {},
  ): DomainEventInput {
    return engineEvent(this.#runId, ts, type, payload, context)
  }

  #specOf(state: TickState, taskId: TaskId): TaskSpec | undefined {
    return state.run.graph.tasks.find((task) => task.id === taskId)
  }

  #settingsOf(spec: TaskSpec): { requireReview: boolean; maxAttempts: number; gate?: string } {
    const settings = resolveTaskSettings(spec, this.#deps.mission.defaults)
    return {
      requireReview: settings.requireReview,
      maxAttempts: settings.maxAttempts,
      gate: settings.gate,
    }
  }

  #dependenciesOf(state: TickState, taskId: TaskId): DependencyState[] {
    const spec = this.#specOf(state, taskId)
    if (spec === undefined) return []
    const states: DependencyState[] = []
    for (const dependency of spec.dependencies) {
      const dependencyRun = state.tasks.get(dependency)
      if (dependencyRun === undefined) continue
      states.push({ taskId: dependency, status: dependencyRun.status })
    }
    return states
  }

  #snapshots(state: TickState): TaskRunSnapshot[] {
    return [...state.tasks.values()].map((task) => ({ taskId: task.taskId, status: task.status }))
  }

  /**
   * P11: transicao nao declarada (ou guarda reprovada) e erro de sistema — registra o
   * evento e NAO altera estado.
   */
  async #recordInvalidTransition(error: InvalidTransitionError, taskId?: TaskId): Promise<void> {
    await this.#write({
      events: [
        this.#event(
          this.#deps.clock.now(),
          'policy.invalid_transition',
          {
            machine: error.machine,
            from: error.from,
            to: error.to,
            trigger: error.trigger,
            reason: error.guard === undefined ? error.reason : `${error.reason}:${error.guard}`,
          },
          { taskId },
        ),
      ],
    })
  }

  async #guard(work: () => Promise<void>, taskId?: TaskId): Promise<void> {
    try {
      await work()
    } catch (error) {
      if (error instanceof InvalidTransitionError) {
        await this.#recordInvalidTransition(error, taskId)
        return
      }
      this.#errors.push(error)
    }
  }

  /** Autorizacao humana de tentativa extra: cada unblock/retry concede uma (I4 respeitada). */
  async #loadGrants(): Promise<void> {
    if (this.#grantsLoaded) return
    this.#grantsLoaded = true
    const reader = this.#deps.events
    if (reader === undefined) return
    const events: DomainEvent[] = await reader.list(this.#runId, {
      types: ['human.task_unblocked'],
    })
    for (const event of events) {
      const taskId = event.taskId
      if (taskId === undefined) continue
      this.#grants.set(taskId, (this.#grants.get(taskId) ?? 0) + 1)
    }
  }

  #maxAttemptsOf(spec: TaskSpec): number {
    return this.#settingsOf(spec).maxAttempts + (this.#grants.get(spec.id) ?? 0)
  }

  // ------------------------------------------------- (a) tentativas orfas

  /**
   * STATE-MACHINES 1.4: tentativa em voo cujo handle de provider nao existe mais e
   * encerrada com `INTERRUPTED`, liberando lock e workspace. NADA e presumido concluido.
   */
  async #reconcile(state: TickState): Promise<void> {
    let persistedLocks: readonly LockRow[] | undefined
    for (const taskRun of [...state.tasks.values()]) {
      if (!ACTIVE_STATUSES.has(taskRun.status)) continue
      const attemptId = taskRun.currentAttemptId
      if (attemptId !== undefined && this.#inflight.has(attemptId)) continue
      // Apos um reinicio o mapa em memoria esta vazio: os locks da tentativa orfa vivem
      // so no banco e precisam ser liberados na MESMA transacao do encerramento.
      persistedLocks ??= await this.#deps.store.listLocks(this.#runId)
      this.#adoptLocks(taskRun.taskId, attemptId, persistedLocks)
      const attempts = await this.#deps.store.loadAttempts(this.#runId, taskRun.taskId)
      const attempt = attempts.find((candidate) => candidate.id === attemptId)
      await this.#guard(
        () =>
          this.#failAttempt(state, taskRun, attempt, {
            code: 'INTERRUPTED',
            detail: 'tentativa sem handle de provider apos reinicio do control plane',
          }),
        taskRun.taskId,
      )
    }
  }

  /** Reassume os locks persistidos da tentativa orfa para que sejam liberados com ela. */
  #adoptLocks(taskId: TaskId, attemptId: AttemptId | undefined, locks: readonly LockRow[]): void {
    if (attemptId === undefined) return
    const held = new Set<PathScope>(this.#locks.get(taskId) ?? [])
    for (const lock of locks) {
      if (lock.attempt_id === attemptId) held.add(lock.path_prefix as PathScope)
    }
    if (held.size > 0) this.#locks.set(taskId, [...held])
  }

  // --------------------------------------------- (b, c) resultados prontos

  async #drainInbox(state: TickState): Promise<void> {
    while (this.#inbox.length > 0) {
      const message = this.#inbox.shift()
      if (message === undefined) break
      const taskId = this.#taskOfMessage(message)
      await this.#guard(() => this.#handle(state, message), taskId)
    }
  }

  #taskOfMessage(message: Message): TaskId | undefined {
    if (message.kind === 'mission-gate') return undefined
    return this.#inflight.get(message.attemptId)?.spec.id
  }

  async #handle(state: TickState, message: Message): Promise<void> {
    if (message.kind === 'mission-gate') return this.#onMissionGate(state, message)
    const inflight = this.#inflight.get(message.attemptId)
    if (inflight === undefined) return
    const taskRun = state.tasks.get(inflight.spec.id)
    if (taskRun === undefined) return
    switch (message.kind) {
      case 'observed':
        return this.#onObserved(state, taskRun, inflight, message)
      case 'gate':
        return this.#onGate(state, taskRun, inflight, message)
      case 'review':
        return this.#onReview(state, taskRun, inflight, message)
      case 'integration':
        return this.#onIntegration(state, taskRun, inflight, message)
      default:
        return
    }
  }

  /**
   * O agente terminou e o control plane ja mediu o workspace. A decisao sai de
   * `Observation` — nunca de `AgentOutcome.claims`, que e apenas persistido (P05).
   */
  async #onObserved(
    state: TickState,
    taskRun: TaskRun,
    inflight: Inflight,
    message: Extract<Message, { kind: 'observed' }>,
  ): Promise<void> {
    const now = this.#deps.clock.now()
    inflight.observation = message.observation
    inflight.attempt = {
      ...inflight.attempt,
      claims: message.outcome.claims,
      usage: message.outcome.usage,
      observation: message.observation,
    }

    const observation = message.observation
    if (message.failure !== undefined || observation === undefined) {
      const failure = message.failure ?? {
        code: 'WORKSPACE_ERROR' as const,
        detail: 'nenhuma observacao foi produzida para a tentativa',
      }
      await this.#failAttempt(state, taskRun, inflight.attempt, failure, inflight)
      return
    }

    const next = applyTransition(taskRun, { to: 'VERIFYING', trigger: 'AGENT_COMPLETED' }, { now })
    inflight.phase = 'verifying'
    const events: DomainEventInput[] = [
      this.#event(
        now,
        'attempt.observed',
        { observation: message.observation as Observation },
        {
          taskId: taskRun.taskId,
          attemptId: inflight.attempt.id,
        },
      ),
      this.#event(
        now,
        'task.verifying',
        { attemptId: inflight.attempt.id },
        {
          taskId: taskRun.taskId,
        },
      ),
    ]
    await this.#write({ taskRun: next, attempt: inflight.attempt, events })
    state.tasks.set(next.taskId, next)
    this.#startTaskGate(inflight)
  }

  async #onGate(
    state: TickState,
    taskRun: TaskRun,
    inflight: Inflight,
    message: Extract<Message, { kind: 'gate' }>,
  ): Promise<void> {
    const now = this.#deps.clock.now()
    const execution = message.execution
    const events: DomainEventInput[] = []
    if (execution !== undefined) {
      inflight.gateExecution = execution
      inflight.attempt = { ...inflight.attempt, gateExecutions: [execution] }
      events.push(
        this.#event(
          execution.startedAt,
          'gate.started',
          {
            gateId: execution.gateId,
            scope: 'task',
          },
          { taskId: taskRun.taskId, attemptId: inflight.attempt.id },
        ),
      )
      for (const result of execution.results) {
        events.push(
          this.#event(
            now,
            'gate.command_finished',
            { result },
            {
              taskId: taskRun.taskId,
              attemptId: inflight.attempt.id,
            },
          ),
        )
      }
      events.push(
        this.#event(
          execution.finishedAt ?? now,
          'gate.finished',
          {
            gateExecutionId: execution.id,
            status: execution.status,
          },
          { taskId: taskRun.taskId, attemptId: inflight.attempt.id },
        ),
      )
      await this.#write({ attempt: inflight.attempt, gate: execution, events })
    }

    if (message.failure !== undefined) {
      await this.#failAttempt(state, taskRun, inflight.attempt, message.failure, inflight)
      return
    }
    if (execution !== undefined && execution.status !== 'PASS') {
      await this.#failAttempt(
        state,
        taskRun,
        inflight.attempt,
        { code: 'GATE_FAILED', detail: `gate ${execution.gateId} terminou ${execution.status}` },
        inflight,
      )
      return
    }

    const settings = this.#settingsOf(inflight.spec)
    if (settings.requireReview) {
      // Fica em VERIFYING ate o scheduler encontrar revisor que satisfaca a politica.
      inflight.phase = 'awaiting-review'
      return
    }
    await this.#toIntegrating(state, taskRun, inflight, {
      requireReview: false,
      policy: 'fresh-session',
      reviewerSlotAvailable: false,
      providerCapacityAvailable: false,
    })
  }

  async #onReview(
    state: TickState,
    taskRun: TaskRun,
    inflight: Inflight,
    message: Extract<Message, { kind: 'review' }>,
  ): Promise<void> {
    const now = this.#deps.clock.now()
    const reviewer = inflight.reviewer
    const policy = inflight.policy ?? 'fresh-session'
    const outcome = message.outcome
    const parsed = parseReview(outcome?.claims)

    if (message.failure !== undefined || outcome === undefined || parsed.verdict === undefined) {
      const failure = message.failure ?? {
        code: 'AGENT_ERROR' as const,
        detail: 'revisor nao emitiu veredito; revisao nao concluiu',
      }
      await this.#failAttempt(state, taskRun, inflight.attempt, failure, inflight)
      return
    }
    if (reviewer === undefined) {
      await this.#failAttempt(
        state,
        taskRun,
        inflight.attempt,
        { code: 'POLICY_VIOLATION', detail: 'revisao sem identidade de revisor registrada' },
        inflight,
      )
      return
    }

    const gateIds = inflight.gateExecution === undefined ? [] : [inflight.gateExecution.gateId]
    const review: Review = {
      id: this.#deps.ids.next('review'),
      attemptId: inflight.attempt.id,
      reviewer,
      input: {
        objective: inflight.spec.objective,
        validation: inflight.spec.validation,
        constraints: this.#deps.mission.constraints,
        touches: inflight.spec.touches,
        diffRef: inflight.observation?.diffRef,
        gateExecutionIds: inflight.gateExecution === undefined ? [] : [inflight.gateExecution.id],
        gateIds,
      },
      verdict: parsed.verdict,
      findings: parsed.findings,
      rationale: parsed.rationale,
      durationMs: message.durationMs,
      policy,
      policyOutcome: inflight.policyOutcome ?? 'satisfied',
    }
    inflight.review = review
    inflight.attempt = { ...inflight.attempt, review }

    const events: DomainEventInput[] = [
      this.#event(
        now,
        'review.finished',
        {
          verdict: review.verdict,
          findings: review.findings.length,
        },
        { taskId: taskRun.taskId, attemptId: inflight.attempt.id },
      ),
    ]
    if (review.verdict === 'ESCALATE') {
      events.push(
        this.#event(
          now,
          'review.escalated',
          { rationale: review.rationale },
          {
            taskId: taskRun.taskId,
            attemptId: inflight.attempt.id,
          },
        ),
      )
    }
    await this.#write({ attempt: inflight.attempt, review, events })

    if (review.verdict === 'PASS') {
      await this.#toIntegrating(state, taskRun, inflight, undefined, {
        verdict: review.verdict,
        reviewer,
        executor: inflight.attempt.executor,
        policy,
        policyOutcome: review.policyOutcome,
      })
      return
    }
    if (review.verdict === 'FAIL') {
      await this.#failAttempt(
        state,
        taskRun,
        inflight.attempt,
        { code: 'REVIEW_FAILED', detail: review.rationale },
        inflight,
      )
      return
    }
    // ESCALATE: ambiguidade arquitetural, nao falha do executor — retry nao resolveria.
    await this.#blockTask(state, taskRun, inflight, 'REVIEW_ESCALATED', {
      kind: 'ARCHITECTURAL',
      reason: `revisao escalou: ${review.rationale}`,
      raisedBy: reviewer.profileId,
      raisedAt: now,
      needs: 'decisao humana sobre a ambiguidade apontada pela revisao',
    })
  }

  async #onIntegration(
    state: TickState,
    taskRun: TaskRun,
    inflight: Inflight,
    message: Extract<Message, { kind: 'integration' }>,
  ): Promise<void> {
    const now = this.#deps.clock.now()
    if (message.failure !== undefined || message.result === undefined) {
      const failure = message.failure ?? {
        code: 'INTEGRATION_CONFLICT' as const,
        detail: 'integracao nao produziu resultado',
      }
      await this.#failAttempt(state, taskRun, inflight.attempt, failure, inflight)
      return
    }
    const result = message.result
    if (result.status === 'CONFLICT') {
      await this.#write({
        events: [
          this.#event(
            now,
            'workspace.conflict',
            { paths: result.conflicts ?? [] },
            {
              taskId: taskRun.taskId,
              attemptId: inflight.attempt.id,
            },
          ),
        ],
      })
      await this.#failAttempt(
        state,
        taskRun,
        inflight.attempt,
        { code: 'INTEGRATION_CONFLICT', detail: result.detail ?? 'conflito ao integrar' },
        inflight,
      )
      return
    }
    if (result.status !== 'MERGED') {
      await this.#failAttempt(
        state,
        taskRun,
        inflight.attempt,
        { code: 'NO_CHANGES', detail: result.detail ?? 'nada a integrar' },
        inflight,
      )
      return
    }

    const settings = this.#settingsOf(inflight.spec)
    const observation = inflight.observation
    const evidence: EvidenceRef[] = []
    if (observation !== undefined) {
      evidence.push(scopeEvidence(inflight.attempt.id, observation, observation.diffRef))
    }
    if (inflight.gateExecution !== undefined) evidence.push(gateEvidence(inflight.gateExecution))
    if (inflight.review !== undefined) evidence.push(reviewEvidence(inflight.review))
    evidence.push(integrationEvidence(inflight.attempt.id, result))

    const doneEvidence = {
      scopeCheck: observation?.scopeCheck,
      gate: { required: settings.gate !== undefined, status: inflight.gateExecution?.status },
      review: {
        required: settings.requireReview,
        verdict: inflight.review?.verdict,
        reviewer: inflight.review?.reviewer,
        policy: inflight.review?.policy,
        policyOutcome: inflight.review?.policyOutcome,
      },
      executor: inflight.attempt.executor,
      integration: result.status,
      evidence,
    }
    const check = isDone(doneEvidence)
    if (!check.ok) {
      // P06 nao satisfeito com merge feito e defeito nosso, nao do agente: nao retenta.
      await this.#failAttempt(
        state,
        taskRun,
        inflight.attempt,
        { code: 'POLICY_VIOLATION', detail: `${check.reason}: ${check.detail}` },
        inflight,
      )
      return
    }

    const attempt: Attempt = {
      ...inflight.attempt,
      finishedAt: now,
      durationMs: now.getTime() - inflight.attempt.startedAt.getTime(),
      result: 'PASS',
      observation:
        observation === undefined
          ? undefined
          : { ...observation, commit: result.commit?.sha ?? observation.commit },
    }
    const next = applyTransition(
      taskRun,
      { to: 'DONE', trigger: 'INTEGRATION_MERGED' },
      { now, evidence: doneEvidence },
    )
    const events: DomainEventInput[] = [
      this.#event(
        now,
        'workspace.integrated',
        {
          status: result.status,
          commit: result.commit?.sha,
        },
        { taskId: taskRun.taskId, attemptId: attempt.id },
      ),
      this.#event(
        now,
        'attempt.finished',
        { result: 'PASS', durationMs: attempt.durationMs ?? 0 },
        {
          taskId: taskRun.taskId,
          attemptId: attempt.id,
        },
      ),
      this.#event(
        now,
        'task.done',
        { evidence },
        { taskId: taskRun.taskId, attemptId: attempt.id },
      ),
      this.#event(
        now,
        'workspace.released',
        { disposition: 'discard' },
        {
          taskId: taskRun.taskId,
          attemptId: attempt.id,
        },
      ),
    ]
    await this.#write({
      taskRun: next,
      attempt,
      events,
      releaseLocks: this.#locks.get(taskRun.taskId) ?? [],
    })
    state.tasks.set(next.taskId, next)
    this.#locks.delete(taskRun.taskId)
    this.#inflight.delete(attempt.id)
    await this.#release(inflight, 'discard')
  }

  async #onMissionGate(
    state: TickState,
    message: Extract<Message, { kind: 'mission-gate' }>,
  ): Promise<void> {
    const now = this.#deps.clock.now()
    const execution = message.execution
    if (execution === undefined) {
      this.#missionGate = { status: 'ERROR' }
      await this.#write({
        events: [
          this.#event(
            now,
            'gate.finished',
            {
              gateExecutionId: 'mission-gate-nao-executado',
              status: 'ERROR',
            },
            {},
          ),
        ],
      })
      return
    }
    this.#missionGate = { status: execution.status, executionId: execution.id }
    // O relatorio final cita o gate da missao mesmo depois de o control plane reiniciar.
    await this.#deps.artifacts
      .write({
        runId: this.#runId,
        kind: 'mission-gate',
        relativePath: MISSION_GATE_ARTIFACT,
        content: JSON.stringify(execution, null, 2),
      })
      .catch((error: unknown) => {
        this.#errors.push(error)
        return undefined
      })
    const run: Run = { ...state.run, missionGateExecutionId: execution.id }
    state.run = run
    await this.#write({
      run,
      gate: execution,
      events: [
        this.#event(
          execution.startedAt,
          'gate.started',
          {
            gateId: execution.gateId,
            scope: 'mission',
          },
          {},
        ),
        this.#event(
          execution.finishedAt ?? now,
          'gate.finished',
          {
            gateExecutionId: execution.id,
            status: execution.status,
          },
          {},
        ),
      ],
    })
  }

  async #toIntegrating(
    state: TickState,
    taskRun: TaskRun,
    inflight: Inflight,
    review?: TaskTransitionReview,
    reviewResult?: TaskTransitionReviewResult,
  ): Promise<void> {
    const now = this.#deps.clock.now()
    const fromReview = taskRun.status === 'REVIEW'
    const next = applyTransition(
      taskRun,
      { to: 'INTEGRATING', trigger: fromReview ? 'REVIEW_PASSED' : 'GATE_PASSED' },
      { now, review, reviewResult },
    )
    inflight.phase = 'integrating'
    await this.#write({
      taskRun: next,
      events: [
        this.#event(
          now,
          'task.integrating',
          { attemptId: inflight.attempt.id },
          {
            taskId: taskRun.taskId,
            attemptId: inflight.attempt.id,
          },
        ),
      ],
    })
    state.tasks.set(next.taskId, next)
    this.#startIntegration(inflight)
  }

  /**
   * Encerra a tentativa, libera lock e workspace e decide o destino: RETRY quando a falha
   * e retentavel e ha orcamento, BLOCKED (escalonamento) caso contrario. Falha de provider
   * nao consome tentativa (`consumesAttempt`) e vai direto para BLOCKED.
   */
  async #failAttempt(
    state: TickState,
    taskRun: TaskRun,
    attempt: Attempt | undefined,
    failure: FailureReason,
    inflight?: Inflight,
  ): Promise<void> {
    const now = this.#deps.clock.now()
    const trigger = FAILED_TRIGGER[taskRun.status] ?? 'ATTEMPT_FAILED'
    const events: DomainEventInput[] = []

    let closed: Attempt | undefined
    if (attempt !== undefined) {
      closed = {
        ...attempt,
        finishedAt: now,
        durationMs: now.getTime() - attempt.startedAt.getTime(),
        result: ATTEMPT_RESULT_OF[failure.code],
        failureReason: failure,
      }
      events.push(
        this.#event(
          now,
          'attempt.finished',
          {
            result: closed.result ?? 'ERROR',
            durationMs: closed.durationMs ?? 0,
          },
          { taskId: taskRun.taskId, attemptId: closed.id },
        ),
      )
    }

    if (failure.code === 'SCOPE_VIOLATION') {
      const occurrence = await this.#occurrencesOf(taskRun.taskId, 'SCOPE_VIOLATION', attempt?.id)
      events.push(
        this.#event(
          now,
          'policy.scope_violation',
          {
            outOfScopePaths: attempt?.observation?.outOfScopePaths ?? [],
            occurrence,
          },
          { taskId: taskRun.taskId, attemptId: attempt?.id },
        ),
      )
    }

    const failed = applyTransition(
      taskRun,
      { to: 'FAILED', trigger },
      { now, failure, reason: failure.detail, attemptId: attempt?.id },
    )
    events.push(
      this.#event(
        now,
        'task.failed',
        { failure },
        {
          taskId: taskRun.taskId,
          attemptId: attempt?.id,
        },
      ),
    )

    const releaseLocks = this.#locks.get(taskRun.taskId) ?? []
    if (attempt !== undefined) {
      // `keep`: a worktree da tentativa reprovada fica no disco para pericia.
      events.push(
        this.#event(
          now,
          'workspace.released',
          { disposition: 'keep' },
          { taskId: taskRun.taskId, attemptId: attempt.id },
        ),
      )
    }
    await this.#write({ taskRun: failed, attempt: closed, events, releaseLocks })
    state.tasks.set(failed.taskId, failed)
    this.#locks.delete(taskRun.taskId)
    if (attempt !== undefined) this.#inflight.delete(attempt.id)
    // `keep` preserva a worktree da tentativa reprovada para pericia (ARCHITECTURE 5.2).
    if (inflight !== undefined) await this.#release(inflight, 'keep')

    await this.#settleFailed(state, failed, failure)
  }

  /** Reincidencia por task, incluindo a ocorrencia atual (contrato de `RetryContext`). */
  async #occurrencesOf(
    taskId: TaskId,
    code: FailureCode,
    currentAttemptId?: AttemptId,
  ): Promise<number> {
    const history = await this.#deps.store.loadAttempts(this.#runId, taskId)
    const previous = history.filter(
      (candidate) => candidate.id !== currentAttemptId && candidate.failureReason?.code === code,
    ).length
    return previous + 1
  }

  /**
   * Transicoes 15/16: com orcamento e falha retentavel vai para RETRY; senao BLOCKED com
   * escalonamento. Run pausado nao decide nada: a task fica em FAILED ate a retomada.
   */
  async #settleFailed(state: TickState, taskRun: TaskRun, known?: FailureReason): Promise<void> {
    if (taskRun.status !== 'FAILED') return
    if (state.run.status !== 'RUNNING') return
    const spec = this.#specOf(state, taskRun.taskId)
    if (spec === undefined) return
    const history = await this.#deps.store.loadAttempts(this.#runId, taskRun.taskId)
    const last = history[history.length - 1]
    const failure = known ??
      last?.failureReason ?? { code: 'AGENT_ERROR', detail: 'falha sem codigo registrado' }
    const count = (code: FailureCode): number =>
      history.filter((candidate) => candidate.failureReason?.code === code).length
    const retryContext = {
      scopeViolationCount: count('SCOPE_VIOLATION'),
      workspaceErrorCount: count('WORKSPACE_ERROR'),
    }
    const maxAttempts = this.#maxAttemptsOf(spec)
    const now = this.#deps.clock.now()
    const events: DomainEventInput[] = []
    let next: TaskRun

    if (
      isRetryable(failure.code, retryContext) &&
      taskRun.attemptCount < maxAttempts &&
      consumesAttempt(failure.code)
    ) {
      const backoffMs = state.run.policies.retryBackoffMs
      next = applyTransition(
        taskRun,
        { to: 'RETRY', trigger: 'RETRY_SCHEDULED' },
        { now, retry: { maxAttempts, failure, retryContext, runPaused: false } },
      )
      this.#retryAt.set(taskRun.taskId, now.getTime() + backoffMs)
      events.push(
        this.#event(
          now,
          'task.retry_scheduled',
          {
            attemptCount: next.attemptCount,
            backoffMs,
          },
          { taskId: taskRun.taskId },
        ),
      )
    } else {
      const blockage = blockageFor(failure, now, taskRun.attemptCount, maxAttempts)
      next = applyTransition(
        taskRun,
        { to: 'BLOCKED', trigger: 'RETRY_EXHAUSTED' },
        { now, blockage },
      )
      events.push(this.#event(now, 'task.blocked', { blockage }, { taskId: taskRun.taskId }))
    }
    await this.#write({ taskRun: next, events })
    state.tasks.set(next.taskId, next)
  }

  async #blockTask(
    state: TickState,
    taskRun: TaskRun,
    inflight: Inflight | undefined,
    trigger: TaskTrigger,
    blockage: Blockage,
    extra: readonly DomainEventInput[] = [],
    reviewReadiness?: TaskTransitionReview,
  ): Promise<void> {
    const now = this.#deps.clock.now()
    const next = applyTransition(
      taskRun,
      { to: 'BLOCKED', trigger },
      { now, blockage, review: reviewReadiness },
    )
    const events: DomainEventInput[] = [...extra]
    let closed: Attempt | undefined
    if (inflight !== undefined) {
      closed = {
        ...inflight.attempt,
        finishedAt: now,
        durationMs: now.getTime() - inflight.attempt.startedAt.getTime(),
        result: 'ERROR',
      }
      events.push(
        this.#event(
          now,
          'attempt.finished',
          {
            result: 'ERROR',
            durationMs: closed.durationMs ?? 0,
          },
          { taskId: taskRun.taskId, attemptId: closed.id },
        ),
      )
    }
    events.push(this.#event(now, 'task.blocked', { blockage }, { taskId: taskRun.taskId }))
    await this.#write({
      taskRun: next,
      attempt: closed,
      events,
      releaseLocks: this.#locks.get(taskRun.taskId) ?? [],
    })
    state.tasks.set(next.taskId, next)
    this.#locks.delete(taskRun.taskId)
    if (inflight !== undefined) {
      this.#inflight.delete(inflight.attempt.id)
      await this.#release(inflight, 'keep')
    }
  }

  /** Cancelamento encerra a tentativa: nada fica aberto fingindo que ainda executa (P11). */
  #closeAttempt(inflight: Inflight | undefined, now: Date, reason?: string): Attempt | undefined {
    if (inflight === undefined) return undefined
    return {
      ...inflight.attempt,
      finishedAt: now,
      durationMs: now.getTime() - inflight.attempt.startedAt.getTime(),
      result: 'CANCELLED',
      failureReason: { code: 'INTERRUPTED', detail: reason ?? 'cancelamento humano' },
    }
  }

  #cancelledAttemptEvents(
    attempt: Attempt | undefined,
    taskId: TaskId,
    now: Date,
    reason?: string,
  ): DomainEventInput[] {
    if (attempt === undefined) return []
    return [
      this.#event(
        now,
        'attempt.cancelled',
        { reason: reason ?? 'cancelamento humano' },
        { taskId, attemptId: attempt.id },
      ),
      this.#event(
        now,
        'attempt.finished',
        { result: 'CANCELLED', durationMs: attempt.durationMs ?? 0 },
        { taskId, attemptId: attempt.id },
      ),
    ]
  }

  async #release(inflight: Inflight, disposition: 'keep' | 'discard'): Promise<void> {
    try {
      await this.#deps.workspaces.release(inflight.workspace, disposition)
    } catch (error) {
      this.#errors.push(error)
    }
  }

  // ------------------------------------------------- (d) tasks READY

  async #promote(state: TickState): Promise<void> {
    if (isTerminalRunStatus(state.run.status)) return
    const now = this.#deps.clock.now()
    for (const taskId of [...state.tasks.keys()]) {
      const taskRun = state.tasks.get(taskId)
      if (taskRun === undefined) continue
      if (taskRun.status === 'FAILED') {
        await this.#guard(() => this.#settleFailed(state, taskRun), taskId)
        continue
      }
      if (taskRun.status === 'PENDING') {
        await this.#guard(() => this.#promotePending(state, taskRun, now), taskId)
        continue
      }
      if (taskRun.status === 'RETRY') {
        const at = this.#retryAt.get(taskId) ?? 0
        if (at > now.getTime()) continue
        await this.#guard(() => this.#promoteRetry(state, taskRun, now), taskId)
      }
    }
    // Backoff pendente so faz sentido para task em RETRY; o resto e lixo de estado anterior.
    for (const taskId of [...this.#retryAt.keys()]) {
      if (state.tasks.get(taskId)?.status !== 'RETRY') this.#retryAt.delete(taskId)
    }
    // Sair de BLOCKED antes do despacho: task destravada precisa de run em RUNNING (t.4).
    if (state.run.status === 'BLOCKED' && !isRunDeadlocked(this.#snapshots(state))) {
      await this.#guard(() =>
        this.#runTransition(state, 'RUNNING', 'TASK_UNBLOCKED', { tasks: this.#snapshots(state) }, [
          (at) => this.#event(at, 'run.resumed', { reason: 'task destravada' }, {}),
        ]),
      )
    }
  }

  async #promotePending(state: TickState, taskRun: TaskRun, now: Date): Promise<void> {
    const dependencies = this.#dependenciesOf(state, taskRun.taskId)
    const cancelled = dependencies.filter((dependency) => dependency.status === 'CANCELLED')
    if (cancelled.length > 0) {
      const blockage: Blockage = {
        kind: 'DEPENDENCY',
        reason: `dependencia cancelada: ${cancelled.map((item) => item.taskId).join(', ')}`,
        raisedBy: 'orchestrator',
        raisedAt: now,
        needs: 'decisao humana sobre a dependencia cancelada',
      }
      const next = applyTransition(
        taskRun,
        { to: 'BLOCKED', trigger: 'DEPENDENCY_FAILED' },
        { now, blockage },
      )
      await this.#write({
        taskRun: next,
        events: [this.#event(now, 'task.blocked', { blockage }, { taskId: taskRun.taskId })],
      })
      state.tasks.set(next.taskId, next)
      return
    }
    const satisfied = dependencies.every(
      (dependency) => dependency.status === 'DONE' || dependency.status === 'SKIPPED',
    )
    if (!satisfied) return
    const next = applyTransition(
      taskRun,
      { to: 'READY', trigger: 'DEPENDENCY_SATISFIED' },
      { now, dependencies },
    )
    await this.#write({
      taskRun: next,
      events: [
        this.#event(
          now,
          'task.ready',
          { unblockedBy: next.unblockedBy },
          {
            taskId: taskRun.taskId,
          },
        ),
      ],
    })
    state.tasks.set(next.taskId, next)
  }

  async #promoteRetry(state: TickState, taskRun: TaskRun, now: Date): Promise<void> {
    const dependencies = this.#dependenciesOf(state, taskRun.taskId)
    const next = applyTransition(
      taskRun,
      { to: 'READY', trigger: 'BACKOFF_ELAPSED' },
      { now, dependencies },
    )
    await this.#write({
      taskRun: next,
      events: [
        this.#event(
          now,
          'task.ready',
          { unblockedBy: next.unblockedBy },
          {
            taskId: taskRun.taskId,
          },
        ),
      ],
    })
    state.tasks.set(next.taskId, next)
    this.#retryAt.delete(taskRun.taskId)
  }

  // ------------------------------------ (e, f) decisoes do scheduler e despacho

  async #dispatch(state: TickState): Promise<void> {
    if (state.run.status !== 'RUNNING' && state.run.status !== 'PAUSED') return
    const specs = new Map<TaskId, TaskSpec>()
    for (const task of state.run.graph.tasks) specs.set(task.id, task)
    const locks: ActiveLock[] = [...this.#locks].map(([taskId, paths]) => ({ taskId, paths }))
    const input: SchedulerInput = {
      graph: state.run.graph,
      tasks: [...state.tasks.values()],
      specs,
      runStatus: state.run.status,
      policies: state.run.policies,
      capacity: this.#deps.registry.capacity(),
      locks,
      executorCandidates: this.#deps.executorProfiles,
      reviewCandidates: this.#reviewCandidates(),
      pendingReviews: this.#pendingReviews(state),
      missionDefaults: this.#deps.mission.defaults,
      projectReviewPolicy: this.#deps.projectReviewPolicy,
      now: this.#deps.clock.now(),
    }
    for (const decision of select(input)) {
      await this.#guard(() => this.#applyDecision(state, decision), decision.taskId)
    }
  }

  /** Sessao nova por tick: identidade de revisor nunca coincide com a do executor (I3). */
  #reviewCandidates(): AgentIdentity[] {
    const startedAt = this.#deps.clock.now()
    return this.#deps.reviewerProfiles.map((profile) => ({
      profileId: profile.id,
      providerId: profile.providerId,
      model: profile.model,
      sessionRef: `review:${this.#tickCount}:${profile.providerId}:${profile.id}`,
      startedAt,
    }))
  }

  #pendingReviews(state: TickState): PendingReview[] {
    const pending: PendingReview[] = []
    for (const inflight of this.#inflight.values()) {
      if (inflight.phase !== 'awaiting-review') continue
      const taskRun = state.tasks.get(inflight.spec.id)
      if (taskRun?.status !== 'VERIFYING') continue
      pending.push({
        taskId: inflight.spec.id,
        attemptId: inflight.attempt.id,
        executor: inflight.attempt.executor,
      })
    }
    return pending
  }

  async #applyDecision(state: TickState, decision: SchedulerDecision): Promise<void> {
    if (decision.kind === 'dispatch-executor') return this.#dispatchExecutor(state, decision)
    if (decision.kind === 'dispatch-reviewer') return this.#dispatchReviewer(state, decision)
    return this.#blockByPolicy(state, decision)
  }

  async #dispatchExecutor(
    state: TickState,
    decision: Extract<SchedulerDecision, { kind: 'dispatch-executor' }>,
  ): Promise<void> {
    const taskRun = state.tasks.get(decision.taskId)
    const spec = this.#specOf(state, decision.taskId)
    if (taskRun === undefined || spec === undefined || taskRun.status !== 'READY') return

    // ADR-0007: arvore compartilhada tem um escritor. Enquanto uma tentativa nao encerra,
    // nem o gate nem a revisao dela liberaram a arvore — despachar seria colisao garantida.
    if (state.run.policies.workspaceMode === 'shared' && this.#inflight.size > 0) return

    const now = this.#deps.clock.now()
    // Workspace que acabou de falhar nao e tentado de novo no mesmo instante: sem isto o
    // tick vira laco quente sobre um erro de ambiente.
    const cooldown = this.#dispatchCooldown.get(spec.id)
    if (cooldown !== undefined && cooldown > now.getTime()) return
    const attemptNumber = taskRun.attemptCount + 1
    const attemptId = toAttemptId(`${spec.id}-a${attemptNumber}-${this.#deps.ids.attemptId()}`)

    let workspace: Workspace
    try {
      workspace = await this.#deps.workspaces.acquire({
        runId: this.#runId,
        taskId: spec.id,
        attemptId,
        kind: state.run.policies.workspaceMode,
        missionId: this.#deps.mission.id,
        attemptNumber,
        touches: spec.touches,
        denyPaths: denyScopes(state.run.policies.denyPaths),
      })
    } catch (error) {
      this.#dispatchCooldown.set(spec.id, now.getTime() + DISPATCH_COOLDOWN_MS)
      // Sem workspace nao ha transicao 4: a guarda reprova e a task continua READY (P11).
      await this.#write({
        events: [
          this.#event(
            now,
            'policy.invalid_transition',
            {
              machine: 'task',
              from: 'READY',
              to: 'RUNNING',
              trigger: 'SCHEDULER_DISPATCH',
              reason: `GUARD_FAILED:workspace-acquired (${describeError(error)})`,
            },
            { taskId: spec.id },
          ),
        ],
      })
      return
    }

    const profile = this.#deps.executorProfiles.find((item) => item.id === decision.profileId)
    const executor: AgentIdentity = {
      profileId: decision.profileId,
      providerId: decision.providerId,
      model: profile?.model,
      sessionRef: `execute:${attemptId}`,
      startedAt: now,
    }
    const workspaceRef: WorkspaceRef = {
      kind: workspace.kind,
      path: workspace.path,
      branch: workspace.branch,
      baseCommit: workspace.baseCommit,
    }
    const attempt: Attempt = {
      id: attemptId,
      taskRunId: toTaskRunId(this.#runId, spec.id),
      attemptNumber,
      executor,
      dispatchReason: decision.reason,
      workspace: workspaceRef,
      startedAt: now,
      gateExecutions: [],
    }
    const next = applyTransition(
      taskRun,
      { to: 'RUNNING', trigger: 'SCHEDULER_DISPATCH' },
      {
        now,
        attemptId,
        dispatch: {
          globalSlotAvailable: true,
          executorSlotAvailable: true,
          providerCapacityAvailable: true,
          touchLocksAcquired: true,
          workspaceAcquired: true,
          runStatus: state.run.status,
        },
      },
    )
    const events: DomainEventInput[] = [
      this.#event(
        now,
        'workspace.acquired',
        { workspace: workspaceRef },
        {
          taskId: spec.id,
          attemptId,
        },
      ),
      this.#event(
        now,
        'attempt.started',
        { attemptNumber, workspace: workspaceRef },
        {
          taskId: spec.id,
          attemptId,
        },
      ),
      this.#event(
        now,
        'task.dispatched',
        { executor, dispatchReason: decision.reason },
        {
          taskId: spec.id,
          attemptId,
        },
      ),
    ]
    await this.#write({
      taskRun: next,
      attempt,
      events,
      acquireLocks: spec.touches.map((path) => ({ path, attemptId })),
    })
    state.tasks.set(next.taskId, next)
    this.#locks.set(spec.id, spec.touches)

    const inflight: Inflight = {
      attempt,
      workspace,
      spec,
      phase: 'running',
      enforceTouches: state.run.policies.enforceTouches,
    }
    this.#inflight.set(attemptId, inflight)

    const assignment = buildExecuteAssignment({
      mission: this.#deps.mission,
      run: state.run,
      spec,
      attemptId,
      workspacePath: workspace.path,
      satisfiedDependencies: spec.dependencies,
      timeoutMs: state.run.policies.attemptTimeoutMs,
    })
    try {
      const provider = this.#deps.registry.get(decision.providerId)
      // I11: o processo do agente sempre comeca na worktree da tentativa.
      const handle = await provider.start(assignment, {
        runId: this.#runId,
        taskId: spec.id,
        attemptId,
        workspace,
        timeoutMs: state.run.policies.attemptTimeoutMs,
        env: this.#deps.agentEnv ?? {},
      })
      inflight.handle = handle
      // Responde "qual processo executou?" sem depender de log (DOMAIN-MODEL 5).
      inflight.attempt = {
        ...inflight.attempt,
        executor: {
          ...executor,
          runtime: { handle: handle.ref, pid: null, cwd: workspace.path, startedAt: now },
        },
      }
      this.#track(this.#afterExecutor(inflight, handle))
    } catch (error) {
      await this.#failAttempt(state, next, attempt, failureReasonOf(error, 'AGENT_ERROR'), inflight)
    }
  }

  /** Fora do tick: espera o agente, mede o workspace e devolve o resultado para o loop. */
  async #afterExecutor(inflight: Inflight, handle: AgentHandle): Promise<void> {
    const outcome = await handle.result()
    inflight.phase = 'observing'
    const observed = await observeAttempt({
      workspaces: this.#deps.workspaces,
      artifacts: this.#deps.artifacts,
      runId: this.#runId,
      taskId: inflight.spec.id,
      attemptNumber: inflight.attempt.attemptNumber,
      workspace: inflight.workspace,
      agentStatus: outcome.status,
      enforceTouches: inflight.enforceTouches,
      commitMessage: `${inflight.spec.id} a${inflight.attempt.attemptNumber}: ${inflight.spec.title}`,
    })
    this.#push({
      kind: 'observed',
      attemptId: inflight.attempt.id,
      outcome,
      observation: observed.observation,
      failure: observed.failure,
    })
  }

  async #dispatchReviewer(
    state: TickState,
    decision: Extract<SchedulerDecision, { kind: 'dispatch-reviewer' }>,
  ): Promise<void> {
    const inflight = this.#inflight.get(decision.attemptId)
    const taskRun = state.tasks.get(decision.taskId)
    if (inflight === undefined || taskRun === undefined) return
    if (inflight.phase !== 'awaiting-review' || taskRun.status !== 'VERIFYING') return

    const now = this.#deps.clock.now()
    // `sessionRef` e a chave de identidade (DOMAIN-MODEL 3.5): sessao nova, identidade
    // nova. Duas revisoes despachadas no mesmo tick para o mesmo perfil sao sessoes
    // distintas, entao a tentativa revisada entra na chave.
    const reviewer: AgentIdentity = {
      ...decision.reviewer,
      sessionRef: `${decision.reviewer.sessionRef}:${decision.attemptId}`,
      startedAt: now,
    }
    inflight.reviewer = reviewer
    inflight.policy = decision.policy
    inflight.policyOutcome = decision.policyOutcome
    const next = applyTransition(
      taskRun,
      { to: 'REVIEW', trigger: 'GATE_PASSED' },
      {
        now,
        review: {
          requireReview: true,
          policy: decision.policy,
          selection: {
            ok: true,
            reviewer,
            policy: decision.policy,
            effectivePolicy:
              decision.policyOutcome === 'downgraded' ? 'fresh-session' : decision.policy,
            policyOutcome: decision.policyOutcome,
          },
          reviewerSlotAvailable: true,
          providerCapacityAvailable: true,
        },
      },
    )
    const events: DomainEventInput[] = [
      this.#event(
        now,
        'task.review_requested',
        { policy: decision.policy, reviewer },
        { taskId: decision.taskId, attemptId: decision.attemptId },
      ),
      this.#event(
        now,
        'review.requested',
        { policy: decision.policy, reviewer },
        { taskId: decision.taskId, attemptId: decision.attemptId },
      ),
    ]
    if (decision.policyOutcome === 'downgraded') {
      // I10: rebaixamento so existe registrado, e nunca em `cross-provider-required`.
      events.push(
        this.#event(
          now,
          'review.policy_downgraded',
          {
            from: decision.policy,
            to: 'fresh-session',
            reason: 'CROSS_PROVIDER_UNAVAILABLE',
          },
          { taskId: decision.taskId, attemptId: decision.attemptId },
        ),
      )
    }
    await this.#write({ taskRun: next, events })
    state.tasks.set(next.taskId, next)
    inflight.phase = 'review'
    inflight.reviewStartedAt = now.getTime()

    const assignment = buildReviewAssignment({
      mission: this.#deps.mission,
      run: state.run,
      spec: inflight.spec,
      attemptId: inflight.attempt.id,
      workspacePath: inflight.workspace.path,
      satisfiedDependencies: inflight.spec.dependencies,
      timeoutMs: state.run.policies.attemptTimeoutMs,
      diffRef: inflight.observation?.diffRef ?? '',
      gateExecutions: inflight.gateExecution === undefined ? [] : [inflight.gateExecution],
      policy: decision.policy,
    })
    try {
      const provider = this.#deps.registry.get(reviewer.providerId)
      const handle = await provider.start(assignment, {
        runId: this.#runId,
        taskId: inflight.spec.id,
        attemptId: inflight.attempt.id,
        workspace: inflight.workspace,
        timeoutMs: state.run.policies.attemptTimeoutMs,
        env: this.#deps.agentEnv ?? {},
      })
      this.#track(this.#afterReviewer(inflight, handle))
    } catch (error) {
      this.#push({
        kind: 'review',
        attemptId: inflight.attempt.id,
        failure: failureReasonOf(error, 'AGENT_ERROR'),
        durationMs: 0,
      })
    }
  }

  async #afterReviewer(inflight: Inflight, handle: AgentHandle): Promise<void> {
    const startedAt = inflight.reviewStartedAt ?? this.#deps.clock.now().getTime()
    const outcome = await handle.result()
    this.#push({
      kind: 'review',
      attemptId: inflight.attempt.id,
      outcome,
      durationMs: Math.max(0, this.#deps.clock.now().getTime() - startedAt),
    })
  }

  /** Transicao 12b: `cross-provider-required` sem segundo fornecedor apto nunca rebaixa. */
  async #blockByPolicy(
    state: TickState,
    decision: Extract<SchedulerDecision, { kind: 'block-task' }>,
  ): Promise<void> {
    const taskRun = state.tasks.get(decision.taskId)
    if (taskRun === undefined || taskRun.status !== 'VERIFYING') return
    const inflight = [...this.#inflight.values()].find((item) => item.spec.id === decision.taskId)
    const now = this.#deps.clock.now()
    await this.#blockTask(
      state,
      taskRun,
      inflight,
      'REVIEW_POLICY_UNSATISFIABLE',
      {
        kind: 'POLICY',
        reason: decision.reason,
        raisedBy: 'orchestrator',
        raisedAt: now,
        needs: 'segundo fornecedor apto a revisar, ou mudanca explicita da politica de revisao',
      },
      [],
      {
        requireReview: true,
        policy: 'cross-provider-required',
        selection: { ok: false, policy: 'cross-provider-required', reason: decision.reason },
        reviewerSlotAvailable: false,
        providerCapacityAvailable: false,
      },
    )
  }

  // ------------------------------------------------- trabalho assincrono

  #startTaskGate(inflight: Inflight): void {
    const gateId = this.#settingsOf(inflight.spec).gate
    if (gateId === undefined) {
      this.#push({ kind: 'gate', attemptId: inflight.attempt.id })
      return
    }
    this.#track(
      (async (): Promise<void> => {
        // ARCHITECTURE 3.4: o gate roda na worktree da tentativa, nunca na arvore principal.
        const outcome = await runGate({
          gates: this.#deps.gates,
          gateRunner: this.#deps.gateRunner,
          artifacts: this.#deps.artifacts,
          runId: this.#runId,
          gateId: toGateId(gateId),
          scope: 'task',
          cwd: inflight.workspace.path,
          attemptId: inflight.attempt.id,
          directory: attemptDirectory(inflight.spec.id, inflight.attempt.attemptNumber),
        })
        this.#push({
          kind: 'gate',
          attemptId: inflight.attempt.id,
          execution: outcome.execution,
          failure: outcome.failure,
        })
      })(),
    )
  }

  #startIntegration(inflight: Inflight): void {
    this.#track(
      (async (): Promise<void> => {
        try {
          const result = await this.#deps.integrator.integrate(inflight.attempt)
          this.#push({ kind: 'integration', attemptId: inflight.attempt.id, result })
        } catch (error) {
          this.#push({
            kind: 'integration',
            attemptId: inflight.attempt.id,
            failure: failureReasonOf(error, 'WORKSPACE_ERROR'),
          })
        }
      })(),
    )
  }

  /**
   * O mission gate valida a ENTREGA INTEGRADA: worktree propria da branch da missao, com o
   * mesmo `workspaceSetup` — nunca a worktree da ultima tentativa (ARCHITECTURE 5.2).
   */
  #startMissionGate(): void {
    if (this.#missionGateStarted) return
    this.#missionGateStarted = true
    const gateId = this.#deps.missionGateId
    if (gateId === undefined) {
      this.#missionGate = { status: 'PASS' }
      return
    }
    this.#track(
      (async (): Promise<void> => {
        const attemptId = toAttemptId(`mission-gate-${this.#deps.ids.attemptId()}`)
        const provider = this.#deps.missionWorkspaces
        let workspace: Workspace | undefined
        try {
          workspace =
            provider === undefined
              ? undefined
              : await provider.acquireMission({
                  runId: this.#runId,
                  attemptId,
                  missionId: this.#deps.mission.id,
                })
          if (workspace === undefined) {
            this.#push({ kind: 'mission-gate' })
            return
          }
          const outcome = await runGate({
            gates: this.#deps.gates,
            gateRunner: this.#deps.gateRunner,
            artifacts: this.#deps.artifacts,
            runId: this.#runId,
            gateId,
            scope: 'mission',
            cwd: workspace.path,
            directory: 'mission',
          })
          this.#push({
            kind: 'mission-gate',
            execution: outcome.execution,
            failure: outcome.failure,
          })
        } finally {
          if (workspace !== undefined && provider !== undefined) {
            await provider.release(workspace, 'discard').catch(() => undefined)
          }
        }
      })(),
    )
  }

  // ------------------------------------------------- (g) estado derivado do run

  async #derive(state: TickState): Promise<void> {
    const snapshots = this.#snapshots(state)
    if (state.run.status === 'RUNNING') {
      if (isRunReadyToVerify(snapshots)) {
        await this.#guard(() =>
          this.#runTransition(state, 'VERIFYING', 'ALL_TASKS_SETTLED', { tasks: snapshots }, [
            (now) => this.#event(now, 'run.verifying', { gateId: this.#deps.missionGateId }, {}),
          ]),
        )
      } else if (isRunDeadlocked(snapshots)) {
        const blocked = snapshots.filter((task) => task.status === 'BLOCKED').map((t) => t.taskId)
        await this.#guard(() =>
          this.#runTransition(state, 'BLOCKED', 'DEADLOCK_DETECTED', { tasks: snapshots }, [
            (now) => this.#event(now, 'run.blocked', { blockedTaskIds: blocked }, {}),
          ]),
        )
      }
    } else if (state.run.status === 'BLOCKED' && !isRunDeadlocked(snapshots)) {
      await this.#guard(() =>
        this.#runTransition(state, 'RUNNING', 'TASK_UNBLOCKED', { tasks: snapshots }, [
          (now) => this.#event(now, 'run.resumed', { reason: 'task destravada' }, {}),
        ]),
      )
    }

    if (state.run.status !== 'VERIFYING') return
    if (this.#missionGate === undefined) {
      this.#startMissionGate()
      if (this.#missionGate === undefined) return
    }
    const gate = this.#missionGate
    if (gate === undefined) return
    const context = {
      tasks: snapshots,
      missionGateStatus: gate.status,
      missionGateExecutionId: gate.executionId,
      // Toda task DONE consolidou na branch da missao antes de sair de INTEGRATING.
      integrationConsolidated: true,
    }
    const completion = checkRunCompletion(context)
    if (gate.status === 'PASS' && completion.ok) {
      await this.#guard(() =>
        this.#runTransition(state, 'COMPLETED', 'MISSION_GATE_PASSED', context, [
          (now) =>
            this.#event(now, 'run.completed', { missionGateExecutionId: gate.executionId }, {}),
        ]),
      )
      return
    }
    // Task CANCELLED presente impede COMPLETED: o run termina FAILED com razao explicita.
    const reason = completion.ok ? `mission gate terminou ${gate.status}` : completion.detail
    const trigger: RunTrigger =
      gate.status === 'PASS' ? 'RUN_NOT_COMPLETABLE' : 'MISSION_GATE_FAILED'
    await this.#guard(() =>
      this.#runTransition(state, 'FAILED', trigger, { ...context, reason }, [
        (now) => this.#event(now, 'run.failed', { reason }, {}),
      ]),
    )
  }

  async #runTransition(
    state: TickState,
    to: RunStatus,
    trigger: RunTrigger,
    context: Parameters<typeof applyRunTransition>[2],
    events: readonly ((now: Date) => DomainEventInput)[],
  ): Promise<void> {
    const now = this.#deps.clock.now()
    const run = applyRunTransition(state.run, { to, trigger }, { ...context, now })
    await this.#write({ run, events: events.map((build) => build(now)) })
    state.run = run
    this.#status = run.status
  }

  // ------------------------------------------------- comandos humanos

  /** Pausa: nada novo e despachado; tentativas em voo terminam (STATE-MACHINES 2.1). */
  pause(command: HumanCommand): Promise<void> {
    return this.#enqueue(async () => {
      const state = await this.#load()
      const now = this.#deps.clock.now()
      const run = applyRunTransition(state.run, { to: 'PAUSED', trigger: 'HUMAN_PAUSE' }, { now })
      await this.#write({
        run,
        events: [
          this.#event(
            now,
            'run.paused',
            { reason: command.reason },
            {
              actor: humanActor(command.actor),
            },
          ),
        ],
      })
      this.#status = run.status
      this.#requestTick()
    })
  }

  resume(command: HumanCommand): Promise<void> {
    return this.#enqueue(async () => {
      const state = await this.#load()
      const now = this.#deps.clock.now()
      const run = applyRunTransition(state.run, { to: 'RUNNING', trigger: 'HUMAN_RESUME' }, { now })
      await this.#write({
        run,
        events: [
          this.#event(
            now,
            'run.resumed',
            { reason: command.reason },
            {
              actor: humanActor(command.actor),
            },
          ),
        ],
      })
      this.#status = run.status
      this.#requestTick()
    })
  }

  /** Cancelamento: tentativa em voo e cancelada no provider e nada e presumido concluido. */
  cancel(command: HumanCommand): Promise<void> {
    return this.#enqueue(async () => {
      this.#closed = true
      const state = await this.#load()
      const now = this.#deps.clock.now()
      for (const inflight of [...this.#inflight.values()]) {
        await inflight.handle?.cancel(command.reason ?? 'run cancelado').catch(() => undefined)
      }
      for (const taskId of [...state.tasks.keys()]) {
        const taskRun = state.tasks.get(taskId)
        if (taskRun === undefined || !CANCELLABLE.has(taskRun.status)) continue
        const next = applyTransition(
          taskRun,
          { to: 'CANCELLED', trigger: 'CANCEL_REQUESTED' },
          { now, reason: command.reason },
        )
        const inflight = [...this.#inflight.values()].find((item) => item.spec.id === taskId)
        const closed = this.#closeAttempt(inflight, now, command.reason)
        await this.#write({
          taskRun: next,
          attempt: closed,
          events: [
            ...this.#cancelledAttemptEvents(closed, taskId, now, command.reason),
            this.#event(now, 'task.cancelled', { reason: command.reason }, { taskId }),
          ],
          releaseLocks: this.#locks.get(taskId) ?? [],
        })
        state.tasks.set(taskId, next)
        this.#locks.delete(taskId)
      }
      for (const inflight of [...this.#inflight.values()]) await this.#release(inflight, 'keep')
      this.#inflight.clear()
      const run = applyRunTransition(
        state.run,
        { to: 'CANCELLED', trigger: 'CANCEL_REQUESTED' },
        { now, reason: command.reason },
      )
      await this.#write({
        run,
        events: [
          this.#event(
            now,
            'human.run_cancelled',
            {
              actor: command.actor,
              reason: command.reason,
            },
            { actor: humanActor(command.actor) },
          ),
          this.#event(
            now,
            'run.cancelled',
            { reason: command.reason },
            {
              actor: humanActor(command.actor),
            },
          ),
        ],
      })
      this.#status = run.status
      this.stop()
    })
  }

  /** Desbloquear exige nota (atrito deliberado) e concede uma tentativa extra autorizada. */
  unblockTask(command: UnblockInput): Promise<void> {
    return this.#enqueue(() => this.#unblock(command))
  }

  /** Retry manual e um unblock com nota padrao: mesma autorizacao, mesmo registro. */
  retryTask(command: TaskCommandInput): Promise<void> {
    return this.#enqueue(() =>
      this.#unblock({
        ...command,
        note: command.reason ?? `retry solicitado por ${command.actor}`,
      }),
    )
  }

  async #unblock(command: UnblockInput): Promise<void> {
    // As autorizacoes ja registradas no log entram ANTES desta: sem isso, um unblock
    // recebido antes do primeiro tick seria contado duas vezes (uma aqui, outra em
    // `#loadGrants`) e o humano concederia duas tentativas em vez de uma (I4).
    await this.#loadGrants()
    const state = await this.#load()
    const taskRun = state.tasks.get(command.taskId)
    if (taskRun === undefined) throw new TaskNotFoundError(command.taskId)
    if (command.note.trim().length === 0) {
      throw new CommandRefusedError('unblock exige nota explicando a decisao')
    }
    const now = this.#deps.clock.now()
    const dependencies = this.#dependenciesOf(state, command.taskId)
    if (taskRun.status === 'FAILED' || taskRun.status === 'RETRY') {
      this.#grants.set(command.taskId, (this.#grants.get(command.taskId) ?? 0) + 1)
      this.#retryAt.set(command.taskId, now.getTime())
      await this.#write({
        events: [
          this.#event(
            now,
            'human.task_unblocked',
            { actor: command.actor, note: command.note },
            {
              taskId: command.taskId,
              actor: humanActor(command.actor),
            },
          ),
        ],
      })
      return
    }
    if (taskRun.status !== 'BLOCKED') {
      throw new CommandRefusedError(`task ${command.taskId} nao esta BLOCKED (${taskRun.status})`)
    }
    const satisfied = dependencies.every(
      (dependency) => dependency.status === 'DONE' || dependency.status === 'SKIPPED',
    )
    const to: TaskStatus = satisfied ? 'READY' : 'PENDING'
    const next = applyTransition(
      taskRun,
      { to, trigger: 'HUMAN_UNBLOCK' },
      { now, dependencies, note: command.note },
    )
    this.#grants.set(command.taskId, (this.#grants.get(command.taskId) ?? 0) + 1)
    await this.#write({
      taskRun: next,
      events: [
        this.#event(
          now,
          'task.unblocked',
          { note: command.note },
          {
            taskId: command.taskId,
            actor: humanActor(command.actor),
          },
        ),
        this.#event(
          now,
          'human.task_unblocked',
          { actor: command.actor, note: command.note },
          {
            taskId: command.taskId,
            actor: humanActor(command.actor),
          },
        ),
      ],
    })
    this.#requestTick()
  }

  /**
   * Cancela UMA task (transicao 21). A tentativa em voo e cancelada no provider; nada e
   * presumido concluido e o run deixa de ser completavel (predicado do dominio).
   */
  cancelTask(command: TaskCommandInput): Promise<void> {
    return this.#enqueue(async () => {
      const state = await this.#load()
      const taskRun = state.tasks.get(command.taskId)
      if (taskRun === undefined) throw new TaskNotFoundError(command.taskId)
      if (!CANCELLABLE.has(taskRun.status)) {
        throw new CommandRefusedError(`task ${command.taskId} ja esta ${taskRun.status}`)
      }
      const now = this.#deps.clock.now()
      const inflight = [...this.#inflight.values()].find((item) => item.spec.id === command.taskId)
      if (inflight !== undefined) {
        await inflight.handle?.cancel(command.reason ?? 'task cancelada').catch(() => undefined)
      }
      const next = applyTransition(
        taskRun,
        { to: 'CANCELLED', trigger: 'CANCEL_REQUESTED' },
        { now, reason: command.reason },
      )
      const closed = this.#closeAttempt(inflight, now, command.reason)
      await this.#write({
        taskRun: next,
        attempt: closed,
        events: [
          ...this.#cancelledAttemptEvents(closed, command.taskId, now, command.reason),
          this.#event(
            now,
            'task.cancelled',
            { reason: command.reason },
            {
              taskId: command.taskId,
              actor: humanActor(command.actor),
            },
          ),
        ],
        releaseLocks: this.#locks.get(command.taskId) ?? [],
      })
      state.tasks.set(next.taskId, next)
      this.#locks.delete(command.taskId)
      if (inflight !== undefined) {
        this.#inflight.delete(inflight.attempt.id)
        await this.#release(inflight, 'keep')
      }
      this.#requestTick()
    })
  }

  /** Pular exige motivo: dispensar trabalho e decisao humana registrada. */
  skipTask(command: TaskCommandInput & { readonly reason: string }): Promise<void> {
    return this.#enqueue(async () => {
      const state = await this.#load()
      const taskRun = state.tasks.get(command.taskId)
      if (taskRun === undefined) throw new TaskNotFoundError(command.taskId)
      if (command.reason.trim().length === 0) {
        throw new CommandRefusedError('skip exige motivo explicito')
      }
      const now = this.#deps.clock.now()
      const next = applyTransition(
        taskRun,
        { to: 'SKIPPED', trigger: 'HUMAN_SKIP' },
        { now, reason: command.reason },
      )
      await this.#write({
        taskRun: next,
        events: [
          this.#event(
            now,
            'task.skipped',
            { reason: command.reason },
            {
              taskId: command.taskId,
              actor: humanActor(command.actor),
            },
          ),
          this.#event(
            now,
            'human.task_skipped',
            { actor: command.actor, reason: command.reason },
            {
              taskId: command.taskId,
              actor: humanActor(command.actor),
            },
          ),
        ],
      })
      this.#requestTick()
    })
  }
}
