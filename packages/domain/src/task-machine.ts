import type { AgentIdentity } from './agent.js'
import { isSameAgentIdentity } from './agent.js'
import { type DoneEvidence, isDone } from './done.js'
import { InvalidTransitionError } from './errors.js'
import {
  consumesAttempt,
  type FailureReason,
  isRetryable,
  type RetryContext,
} from './failure-codes.js'
import type { AttemptId, TaskId } from './ids.js'
import type {
  ReviewerSelection,
  ReviewPolicy,
  ReviewPolicyOutcome,
  ReviewVerdict,
} from './review.js'
import type { RunStatus } from './run.js'
import type { Blockage, TaskRun, TaskStatus } from './task-run.js'

export const TASK_TRIGGERS = [
  'RUN_CREATED',
  'DEPENDENCY_SATISFIED',
  'DEPENDENCY_FAILED',
  'HUMAN_BLOCK',
  'SCHEDULER_DISPATCH',
  'AGENT_COMPLETED',
  'ATTEMPT_FAILED',
  'GATE_PASSED',
  'GATE_FAILED',
  'REVIEW_PASSED',
  'REVIEW_FAILED',
  'REVIEW_ESCALATED',
  'REVIEW_POLICY_UNSATISFIABLE',
  'INTEGRATION_MERGED',
  'INTEGRATION_CONFLICT',
  'RETRY_SCHEDULED',
  'RETRY_EXHAUSTED',
  'BACKOFF_ELAPSED',
  'HUMAN_UNBLOCK',
  'HUMAN_SKIP',
  'CANCEL_REQUESTED',
  'HUMAN_REOPEN',
] as const
export type TaskTrigger = (typeof TASK_TRIGGERS)[number]

export interface DependencyState {
  readonly taskId: TaskId
  readonly status: TaskStatus
}

export interface DispatchReadiness {
  readonly globalSlotAvailable: boolean
  readonly executorSlotAvailable: boolean
  readonly providerCapacityAvailable: boolean
  readonly touchLocksAcquired: boolean
  readonly workspaceAcquired: boolean
  readonly runStatus: RunStatus
}

export interface ReviewReadiness {
  readonly requireReview: boolean
  readonly policy: ReviewPolicy
  readonly selection?: ReviewerSelection
  readonly reviewerSlotAvailable: boolean
  readonly providerCapacityAvailable: boolean
}

export interface ReviewResultState {
  readonly verdict: ReviewVerdict
  readonly reviewer: AgentIdentity
  readonly executor: AgentIdentity
  readonly policy: ReviewPolicy
  readonly policyOutcome: ReviewPolicyOutcome
}

export interface RetryReadiness {
  readonly maxAttempts: number
  readonly failure: FailureReason
  readonly retryContext?: RetryContext
  readonly runPaused: boolean
}

/**
 * Tudo que uma guarda pode consultar. Nenhuma guarda faz I/O: o orquestrador monta o
 * retrato e a maquina decide (P10 / I7).
 */
export interface TaskTransitionContext {
  /** Sem relogio proprio: sem `now`, os carimbos de tempo simplesmente nao sao atualizados. */
  readonly now?: Date
  readonly dependencies?: readonly DependencyState[]
  readonly dependents?: readonly DependencyState[]
  readonly dispatch?: DispatchReadiness
  readonly review?: ReviewReadiness
  readonly reviewResult?: ReviewResultState
  readonly evidence?: DoneEvidence
  readonly retry?: RetryReadiness
  readonly failure?: FailureReason
  readonly attemptId?: AttemptId
  readonly blockage?: Blockage
  readonly note?: string
  readonly reason?: string
  readonly unblockedBy?: readonly TaskId[]
}

export interface TaskGuard {
  readonly name: string
  readonly check: (taskRun: TaskRun, ctx: TaskTransitionContext) => boolean
}

export interface TaskTransition {
  /** Numero da linha na tabela de STATE-MACHINES 1.3. */
  readonly id: string
  readonly from: TaskStatus | null
  readonly to: TaskStatus
  readonly trigger: TaskTrigger
  readonly guard?: TaskGuard
  readonly description: string
}

function dependenciesAreSatisfied(ctx: TaskTransitionContext): boolean {
  return (ctx.dependencies ?? []).every(
    (dependency) => dependency.status === 'DONE' || dependency.status === 'SKIPPED',
  )
}

const dependenciesSatisfied: TaskGuard = {
  name: 'dependencies-satisfied',
  check: (_taskRun, ctx) => dependenciesAreSatisfied(ctx),
}

const dependenciesNotSatisfied: TaskGuard = {
  name: 'dependencies-not-satisfied',
  check: (_taskRun, ctx) => !dependenciesAreSatisfied(ctx),
}

const dependenciesStillSatisfied: TaskGuard = {
  name: 'dependencies-still-satisfied',
  check: (_taskRun, ctx) => dependenciesAreSatisfied(ctx),
}

const dependenciesSatisfiedWithNote: TaskGuard = {
  name: 'dependencies-satisfied-with-note',
  check: (_taskRun, ctx) => dependenciesAreSatisfied(ctx) && (ctx.note ?? '').trim().length > 0,
}

const dispatchReady: TaskGuard = {
  name: 'dispatch-ready',
  check: (_taskRun, ctx) => {
    const dispatch = ctx.dispatch
    if (dispatch === undefined) return false
    return (
      dispatch.globalSlotAvailable &&
      dispatch.executorSlotAvailable &&
      dispatch.providerCapacityAvailable &&
      dispatch.touchLocksAcquired &&
      dispatch.workspaceAcquired &&
      dispatch.runStatus === 'RUNNING'
    )
  },
}

const reviewerAvailable: TaskGuard = {
  name: 'reviewer-available',
  check: (_taskRun, ctx) => {
    const review = ctx.review
    if (review === undefined || !review.requireReview) return false
    if (review.selection === undefined || !review.selection.ok) return false
    return review.reviewerSlotAvailable && review.providerCapacityAvailable
  },
}

const reviewNotRequired: TaskGuard = {
  name: 'review-not-required',
  check: (_taskRun, ctx) => ctx.review !== undefined && ctx.review.requireReview === false,
}

const reviewPassedByIndependentReviewer: TaskGuard = {
  name: 'review-passed-by-independent-reviewer',
  check: (_taskRun, ctx) => {
    const result = ctx.reviewResult
    if (result === undefined || result.verdict !== 'PASS') return false
    if (isSameAgentIdentity(result.reviewer, result.executor)) return false
    if (result.policy === 'cross-provider-required') {
      return (
        result.policyOutcome === 'satisfied' &&
        result.reviewer.providerId !== result.executor.providerId
      )
    }
    if (result.policyOutcome === 'downgraded') return result.policy === 'cross-provider-preferred'
    return true
  },
}

/**
 * Politica de revisao que NAO da para satisfazer com os fornecedores declarados.
 *
 * Tres causas, um destino. `cross-provider-required` sem segundo fornecedor apto nunca
 * rebaixa (I10). Revisor de ENSAIO nao satisfaz politica nenhuma, nem `fresh-session`: um
 * roteiro fixo nao e a segunda leitura independente que a revisao promete (P07). E projeto
 * que nao declarou revisor nenhum nao ganha um esperando. Nos tres casos a task para COM
 * MOTIVO, em vez de girar em silencio ou aprovar de mentira.
 *
 * Falta de VAGA nao chega aqui: o escalonamento a trata como espera, que e o que ela e.
 */
const reviewPolicyUnsatisfiable: TaskGuard = {
  name: 'review-policy-unsatisfiable',
  check: (_taskRun, ctx) => {
    const review = ctx.review
    if (review === undefined || !review.requireReview) return false
    const selection = review.selection
    if (selection === undefined || selection.ok) return false
    if (selection.reason !== 'CROSS_PROVIDER_UNAVAILABLE') return true
    return review.policy === 'cross-provider-required'
  },
}

const donePredicateSatisfied: TaskGuard = {
  name: 'done-predicate',
  check: (_taskRun, ctx) => ctx.evidence !== undefined && isDone(ctx.evidence).ok,
}

const retryAllowed: TaskGuard = {
  name: 'retry-allowed',
  check: (taskRun, ctx) => {
    const retry = ctx.retry
    if (retry === undefined) return false
    if (retry.runPaused) return false
    if (taskRun.attemptCount >= retry.maxAttempts) return false
    return isRetryable(retry.failure.code, retry.retryContext)
  },
}

const noDependentConsumedResult: TaskGuard = {
  name: 'no-dependent-consumed-result',
  check: (_taskRun, ctx) =>
    (ctx.dependents ?? []).every(
      (dependent) =>
        dependent.status === 'PENDING' ||
        dependent.status === 'READY' ||
        dependent.status === 'BLOCKED',
    ),
}

/** Transicao 21: "qualquer nao terminal" -> CANCELLED. */
export const CANCELLABLE_TASK_STATUSES = [
  'PENDING',
  'READY',
  'RUNNING',
  'VERIFYING',
  'REVIEW',
  'INTEGRATING',
  'FAILED',
  'RETRY',
  'BLOCKED',
] as const

const cancelTransitions: readonly TaskTransition[] = CANCELLABLE_TASK_STATUSES.map((from) => ({
  id: '21',
  from,
  to: 'CANCELLED',
  trigger: 'CANCEL_REQUESTED',
  description: 'cancelamento do run ou da task; tentativa em voo e cancelada no provider',
}))

/**
 * A maquina de estados da Task e DADO, nao cadeia de ifs: cada linha corresponde a uma
 * linha da tabela de STATE-MACHINES 1.3.
 */
export const TASK_TRANSITIONS: readonly TaskTransition[] = [
  {
    id: '1',
    from: null,
    to: 'PENDING',
    trigger: 'RUN_CREATED',
    description: 'criacao do run',
  },
  {
    id: '2',
    from: 'PENDING',
    to: 'READY',
    trigger: 'DEPENDENCY_SATISFIED',
    guard: dependenciesSatisfied,
    description: 'todas as deps em DONE ou SKIPPED',
  },
  {
    id: '3',
    from: 'PENDING',
    to: 'BLOCKED',
    trigger: 'DEPENDENCY_FAILED',
    description: 'dependencia terminou em FAILED/CANCELLED',
  },
  {
    id: '3',
    from: 'PENDING',
    to: 'BLOCKED',
    trigger: 'HUMAN_BLOCK',
    description: 'bloqueio humano',
  },
  {
    id: '4',
    from: 'READY',
    to: 'RUNNING',
    trigger: 'SCHEDULER_DISPATCH',
    guard: dispatchReady,
    description: 'slots, capacidade do provider, locks de touches e workspace obtidos',
  },
  {
    id: '5',
    from: 'RUNNING',
    to: 'VERIFYING',
    trigger: 'AGENT_COMPLETED',
    description: 'agente encerrou com status=completed',
  },
  {
    id: '6',
    from: 'RUNNING',
    to: 'FAILED',
    trigger: 'ATTEMPT_FAILED',
    description: 'erro, timeout, ausencia de alteracoes ou SCOPE_VIOLATION',
  },
  {
    id: '7',
    from: 'VERIFYING',
    to: 'REVIEW',
    trigger: 'GATE_PASSED',
    guard: reviewerAvailable,
    description: 'gate PASS com requireReview e revisor que satisfaz a politica resolvida',
  },
  {
    id: '8',
    from: 'VERIFYING',
    to: 'INTEGRATING',
    trigger: 'GATE_PASSED',
    guard: reviewNotRequired,
    description: 'gate PASS sem revisao exigida',
  },
  {
    id: '9',
    from: 'VERIFYING',
    to: 'FAILED',
    trigger: 'GATE_FAILED',
    description: 'task gate FAIL/ERROR/TIMEOUT',
  },
  {
    id: '10',
    from: 'REVIEW',
    to: 'INTEGRATING',
    trigger: 'REVIEW_PASSED',
    guard: reviewPassedByIndependentReviewer,
    description: 'veredito PASS com reviewer != executor e politica satisfeita ou rebaixada',
  },
  {
    id: '11',
    from: 'REVIEW',
    to: 'FAILED',
    trigger: 'REVIEW_FAILED',
    description: 'veredito FAIL',
  },
  {
    id: '12',
    from: 'REVIEW',
    to: 'BLOCKED',
    trigger: 'REVIEW_ESCALATED',
    description: 'veredito ESCALATE: ambiguidade arquitetural, nao falha do executor',
  },
  {
    id: '12b',
    from: 'VERIFYING',
    to: 'BLOCKED',
    trigger: 'REVIEW_POLICY_UNSATISFIABLE',
    guard: reviewPolicyUnsatisfiable,
    description:
      'politica de revisao insatisfazivel: sem segundo fornecedor apto, ou so revisor de ensaio',
  },
  {
    id: '13',
    from: 'INTEGRATING',
    to: 'DONE',
    trigger: 'INTEGRATION_MERGED',
    guard: donePredicateSatisfied,
    description: 'merge concluido e predicado P06 satisfeito',
  },
  {
    id: '14',
    from: 'INTEGRATING',
    to: 'FAILED',
    trigger: 'INTEGRATION_CONFLICT',
    description: 'INTEGRATION_CONFLICT',
  },
  {
    id: '15',
    from: 'FAILED',
    to: 'RETRY',
    trigger: 'RETRY_SCHEDULED',
    guard: retryAllowed,
    description: 'attemptCount < maxAttempts, falha retentavel e run nao pausado',
  },
  {
    id: '16',
    from: 'FAILED',
    to: 'BLOCKED',
    trigger: 'RETRY_EXHAUSTED',
    description: 'tentativas esgotadas ou falha nao retentavel',
  },
  {
    id: '17',
    from: 'RETRY',
    to: 'READY',
    trigger: 'BACKOFF_ELAPSED',
    guard: dependenciesStillSatisfied,
    description: 'backoff cumprido e deps ainda satisfeitas',
  },
  {
    id: '18',
    from: 'BLOCKED',
    to: 'READY',
    trigger: 'HUMAN_UNBLOCK',
    guard: dependenciesSatisfiedWithNote,
    description: 'unblock humano com deps satisfeitas; exige nota',
  },
  {
    id: '19',
    from: 'BLOCKED',
    to: 'PENDING',
    trigger: 'HUMAN_UNBLOCK',
    guard: dependenciesNotSatisfied,
    description: 'unblock humano com deps ainda nao satisfeitas',
  },
  {
    id: '20',
    from: 'BLOCKED',
    to: 'SKIPPED',
    trigger: 'HUMAN_SKIP',
    description: 'skip humano com razao',
  },
  ...cancelTransitions,
  {
    id: '22',
    from: 'PENDING',
    to: 'SKIPPED',
    trigger: 'HUMAN_SKIP',
    description: 'decisao humana (a variante a partir de BLOCKED e a linha 20)',
  },
  {
    id: '22',
    from: 'READY',
    to: 'SKIPPED',
    trigger: 'HUMAN_SKIP',
    description: 'decisao humana',
  },
  {
    id: '23',
    from: 'DONE',
    to: 'READY',
    trigger: 'HUMAN_REOPEN',
    guard: noDependentConsumedResult,
    description: 'reabertura formal: nenhum dependente saiu de PENDING/READY/BLOCKED',
  },
]

function key(from: TaskStatus | null, to: TaskStatus, trigger: TaskTrigger): string {
  return `${from ?? '-'}|${to}|${trigger}`
}

const TRANSITION_INDEX: ReadonlyMap<string, TaskTransition> = new Map(
  TASK_TRANSITIONS.map((transition) => [
    key(transition.from, transition.to, transition.trigger),
    transition,
  ]),
)

export function findTaskTransition(
  from: TaskStatus | null,
  to: TaskStatus,
  trigger: TaskTrigger,
): TaskTransition | undefined {
  return TRANSITION_INDEX.get(key(from, to, trigger))
}

/** Somente a tabela: guardas dependem de contexto e sao avaliadas em `applyTransition`. */
export function canTransition(
  from: TaskStatus | null,
  to: TaskStatus,
  trigger: TaskTrigger,
): boolean {
  return findTaskTransition(from, to, trigger) !== undefined
}

export function transitionsFrom(from: TaskStatus | null): TaskTransition[] {
  return TASK_TRANSITIONS.filter((transition) => transition.from === from)
}

export interface TaskTransitionRequest {
  readonly to: TaskStatus
  readonly trigger: TaskTrigger
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const OUTCOME_STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
  'DONE',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
])

function nextTaskRun(
  taskRun: TaskRun,
  transition: TaskTransition,
  ctx: TaskTransitionContext,
): TaskRun {
  const now = ctx.now
  const draft: Mutable<TaskRun> = { ...taskRun, status: transition.to }

  if (!OUTCOME_STATUSES.has(transition.to)) draft.outcome = undefined

  switch (transition.to) {
    case 'READY': {
      if (now !== undefined) draft.readyAt = now
      const unblockedBy =
        ctx.unblockedBy ??
        (ctx.dependencies ?? [])
          .filter((d) => d.status === 'DONE' || d.status === 'SKIPPED')
          .map((d) => d.taskId)
      if (unblockedBy.length > 0) draft.unblockedBy = unblockedBy
      if (transition.id === '23') {
        draft.finishedAt = undefined
        draft.currentAttemptId = undefined
      }
      break
    }
    case 'RUNNING': {
      if (now !== undefined && taskRun.startedAt === undefined) draft.startedAt = now
      if (ctx.attemptId !== undefined) draft.currentAttemptId = ctx.attemptId
      break
    }
    case 'VERIFYING': {
      // Uma tentativa = um despacho: o orcamento e consumido ao sair de RUNNING.
      if (transition.from === 'RUNNING') draft.attemptCount = taskRun.attemptCount + 1
      break
    }
    case 'FAILED': {
      const code = ctx.failure?.code
      if (transition.from === 'RUNNING' && (code === undefined || consumesAttempt(code))) {
        draft.attemptCount = taskRun.attemptCount + 1
      }
      draft.outcome = {
        kind: 'FAILED',
        reason: ctx.reason ?? ctx.failure?.detail,
        failureCode: code,
      }
      break
    }
    case 'BLOCKED': {
      if (ctx.blockage !== undefined) draft.blockage = ctx.blockage
      break
    }
    case 'DONE': {
      if (now !== undefined) draft.finishedAt = now
      draft.outcome = { kind: 'DONE', reason: ctx.reason }
      draft.blockage = undefined
      break
    }
    case 'SKIPPED': {
      if (now !== undefined) draft.finishedAt = now
      draft.outcome = { kind: 'SKIPPED', reason: ctx.reason }
      break
    }
    case 'CANCELLED': {
      if (now !== undefined) draft.finishedAt = now
      draft.outcome = { kind: 'CANCELLED', reason: ctx.reason }
      break
    }
    default:
      break
  }

  if (
    transition.from === 'BLOCKED' &&
    transition.to !== 'BLOCKED' &&
    taskRun.blockage !== undefined
  ) {
    draft.blockage = {
      ...taskRun.blockage,
      resolvedAt: now ?? taskRun.blockage.resolvedAt,
      resolution: ctx.note ?? ctx.reason ?? taskRun.blockage.resolution,
    }
  }

  return draft
}

/**
 * Aplica uma transicao declarada. Transicao ausente da tabela ou guarda reprovada lancam
 * `InvalidTransitionError` — e o valor recebido nao e alterado (P11).
 */
export function applyTransition(
  taskRun: TaskRun,
  transition: TaskTransitionRequest,
  ctx: TaskTransitionContext = {},
): TaskRun {
  const declared = findTaskTransition(taskRun.status, transition.to, transition.trigger)
  if (declared === undefined) {
    throw new InvalidTransitionError(
      'task',
      taskRun.status,
      transition.to,
      transition.trigger,
      'NOT_LISTED',
    )
  }
  if (declared.guard !== undefined && !declared.guard.check(taskRun, ctx)) {
    throw new InvalidTransitionError(
      'task',
      taskRun.status,
      transition.to,
      transition.trigger,
      'GUARD_FAILED',
      declared.guard.name,
    )
  }
  return nextTaskRun(taskRun, declared, ctx)
}
