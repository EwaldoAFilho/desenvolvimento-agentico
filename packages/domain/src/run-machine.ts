import { InvalidTransitionError } from './errors.js'
import type { GateStatus } from './gate.js'
import type { TaskId } from './ids.js'
import type { Run, RunStatus } from './run.js'
import { isProgressingTaskStatus, type TaskStatus } from './task-run.js'

export const RUN_TRIGGERS = [
  'RUN_CREATED',
  'HUMAN_APPROVED',
  'RUN_STARTED',
  'HUMAN_PAUSE',
  'HUMAN_RESUME',
  'DEADLOCK_DETECTED',
  'TASK_UNBLOCKED',
  'ALL_TASKS_SETTLED',
  'MISSION_GATE_PASSED',
  'MISSION_GATE_FAILED',
  'RUN_NOT_COMPLETABLE',
  'CANCEL_REQUESTED',
] as const
export type RunTrigger = (typeof RUN_TRIGGERS)[number]

export interface TaskRunSnapshot {
  readonly taskId: TaskId
  readonly status: TaskStatus
}

export type DiagnosticSeverity = 'ERROR' | 'WARNING' | 'INFO'

export interface RunTransitionContext {
  readonly now?: Date
  readonly tasks?: readonly TaskRunSnapshot[]
  readonly diagnostics?: readonly { readonly severity: DiagnosticSeverity }[]
  /** Aprovacao humana registrada (`human.mission_approved`). Nao existe aprovacao automatica. */
  readonly approval?: { readonly actor: string; readonly at: Date }
  readonly warningsAccepted?: boolean
  readonly missionGateStatus?: GateStatus
  readonly missionGateExecutionId?: string
  readonly integrationConsolidated?: boolean
  readonly reason?: string
}

/** BLOCKED derivado: nada pode progredir e existe ao menos uma task BLOCKED. */
export function isRunDeadlocked(tasks: readonly TaskRunSnapshot[]): boolean {
  const progressing = tasks.some((task) => isProgressingTaskStatus(task.status))
  const blocked = tasks.some((task) => task.status === 'BLOCKED')
  return !progressing && blocked
}

/** VERIFYING derivado: todas encerradas e ao menos uma DONE. */
export function isRunReadyToVerify(tasks: readonly TaskRunSnapshot[]): boolean {
  if (tasks.length === 0) return false
  const settled = tasks.every(
    (task) => task.status === 'DONE' || task.status === 'SKIPPED' || task.status === 'CANCELLED',
  )
  return settled && tasks.some((task) => task.status === 'DONE')
}

export const RUN_COMPLETION_FAILURES = [
  'TASKS_NOT_SETTLED',
  'CANCELLED_TASK_PRESENT',
  'NO_TASK_DONE',
  'MISSION_GATE_NOT_PASSED',
  'INTEGRATION_NOT_CONSOLIDATED',
] as const
export type RunCompletionFailure = (typeof RUN_COMPLETION_FAILURES)[number]

export type RunCompletionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RunCompletionFailure; readonly detail: string }

/**
 * COMPLETED: toda task em DONE ou SKIPPED, mission gate PASS e branch consolidada.
 * Uma task CANCELLED impede COMPLETED — concluir com pedaco cancelado seria mentir.
 */
export function checkRunCompletion(ctx: RunTransitionContext): RunCompletionCheck {
  const tasks = ctx.tasks ?? []
  if (tasks.some((task) => task.status === 'CANCELLED')) {
    return {
      ok: false,
      reason: 'CANCELLED_TASK_PRESENT',
      detail: 'task CANCELLED impede COMPLETED; o run termina FAILED',
    }
  }
  if (!tasks.every((task) => task.status === 'DONE' || task.status === 'SKIPPED')) {
    return { ok: false, reason: 'TASKS_NOT_SETTLED', detail: 'ha task fora de DONE/SKIPPED' }
  }
  if (!tasks.some((task) => task.status === 'DONE')) {
    return { ok: false, reason: 'NO_TASK_DONE', detail: 'nenhuma task concluida' }
  }
  if (ctx.missionGateStatus !== 'PASS') {
    return {
      ok: false,
      reason: 'MISSION_GATE_NOT_PASSED',
      detail: `mission gate esta ${ctx.missionGateStatus ?? 'ausente'}`,
    }
  }
  if (ctx.integrationConsolidated !== true) {
    return {
      ok: false,
      reason: 'INTEGRATION_NOT_CONSOLIDATED',
      detail: 'branch da missao nao consolidada',
    }
  }
  return { ok: true }
}

export interface RunGuard {
  readonly name: string
  readonly check: (run: Run, ctx: RunTransitionContext) => boolean
}

export interface RunTransition {
  readonly id: string
  readonly from: RunStatus | null
  readonly to: RunStatus
  readonly trigger: RunTrigger
  readonly guard?: RunGuard
  readonly description: string
}

const compiledAndApproved: RunGuard = {
  name: 'compiled-without-errors-and-approved',
  check: (_run, ctx) => {
    const hasError = (ctx.diagnostics ?? []).some((d) => d.severity === 'ERROR')
    return !hasError && ctx.approval !== undefined
  },
}

const warningsAcceptedIfAny: RunGuard = {
  name: 'warnings-accepted-if-any',
  check: (_run, ctx) => {
    const hasWarning = (ctx.diagnostics ?? []).some((d) => d.severity === 'WARNING')
    return !hasWarning || ctx.warningsAccepted === true
  },
}

const runDeadlocked: RunGuard = {
  name: 'run-deadlocked',
  check: (_run, ctx) => isRunDeadlocked(ctx.tasks ?? []),
}

const runNotDeadlocked: RunGuard = {
  name: 'run-not-deadlocked',
  check: (_run, ctx) => !isRunDeadlocked(ctx.tasks ?? []),
}

const allTasksSettled: RunGuard = {
  name: 'all-tasks-settled',
  check: (_run, ctx) => isRunReadyToVerify(ctx.tasks ?? []),
}

const runCompletable: RunGuard = {
  name: 'run-completable',
  check: (_run, ctx) => checkRunCompletion(ctx).ok,
}

const runNotCompletable: RunGuard = {
  name: 'run-not-completable',
  check: (_run, ctx) => !checkRunCompletion(ctx).ok,
}

export const CANCELLABLE_RUN_STATUSES = [
  'DRAFT',
  'APPROVED',
  'RUNNING',
  'PAUSED',
  'BLOCKED',
  'VERIFYING',
] as const

const cancelTransitions: readonly RunTransition[] = CANCELLABLE_RUN_STATUSES.map((from) => ({
  id: 'R12',
  from,
  to: 'CANCELLED',
  trigger: 'CANCEL_REQUESTED',
  description: 'cancelamento humano do run',
}))

export const RUN_TRANSITIONS: readonly RunTransition[] = [
  { id: 'R1', from: null, to: 'DRAFT', trigger: 'RUN_CREATED', description: 'spec existe' },
  {
    id: 'R2',
    from: 'DRAFT',
    to: 'APPROVED',
    trigger: 'HUMAN_APPROVED',
    guard: compiledAndApproved,
    description: 'compilada sem ERROR e aprovacao humana registrada',
  },
  {
    id: 'R3',
    from: 'APPROVED',
    to: 'RUNNING',
    trigger: 'RUN_STARTED',
    guard: warningsAcceptedIfAny,
    description: 'START MISSION; WARNING exige aceite explicito',
  },
  {
    id: 'R4',
    from: 'RUNNING',
    to: 'PAUSED',
    trigger: 'HUMAN_PAUSE',
    description: 'nada novo e despachado; tentativas em voo terminam',
  },
  { id: 'R5', from: 'PAUSED', to: 'RUNNING', trigger: 'HUMAN_RESUME', description: 'retomada' },
  {
    id: 'R6',
    from: 'RUNNING',
    to: 'BLOCKED',
    trigger: 'DEADLOCK_DETECTED',
    guard: runDeadlocked,
    description: 'derivado: nada progride e ha task BLOCKED',
  },
  {
    id: 'R7',
    from: 'BLOCKED',
    to: 'RUNNING',
    trigger: 'TASK_UNBLOCKED',
    guard: runNotDeadlocked,
    description: 'humano destravou ao menos uma task',
  },
  {
    id: 'R8',
    from: 'RUNNING',
    to: 'VERIFYING',
    trigger: 'ALL_TASKS_SETTLED',
    guard: allTasksSettled,
    description: 'todas encerradas; mission gate em execucao',
  },
  {
    id: 'R9',
    from: 'VERIFYING',
    to: 'COMPLETED',
    trigger: 'MISSION_GATE_PASSED',
    guard: runCompletable,
    description: 'mission gate PASS e predicado da missao satisfeito',
  },
  {
    id: 'R10',
    from: 'VERIFYING',
    to: 'FAILED',
    trigger: 'MISSION_GATE_FAILED',
    description: 'mission gate FAIL',
  },
  {
    id: 'R11',
    from: 'VERIFYING',
    to: 'FAILED',
    trigger: 'RUN_NOT_COMPLETABLE',
    guard: runNotCompletable,
    description: 'encerrado com task cancelada ou reprovada sem saida',
  },
  ...cancelTransitions,
]

function key(from: RunStatus | null, to: RunStatus, trigger: RunTrigger): string {
  return `${from ?? '-'}|${to}|${trigger}`
}

const TRANSITION_INDEX: ReadonlyMap<string, RunTransition> = new Map(
  RUN_TRANSITIONS.map((transition) => [
    key(transition.from, transition.to, transition.trigger),
    transition,
  ]),
)

export function findRunTransition(
  from: RunStatus | null,
  to: RunStatus,
  trigger: RunTrigger,
): RunTransition | undefined {
  return TRANSITION_INDEX.get(key(from, to, trigger))
}

export function canRunTransition(
  from: RunStatus | null,
  to: RunStatus,
  trigger: RunTrigger,
): boolean {
  return findRunTransition(from, to, trigger) !== undefined
}

export function runTransitionsFrom(from: RunStatus | null): RunTransition[] {
  return RUN_TRANSITIONS.filter((transition) => transition.from === from)
}

/** Estado derivado sugerido a cada tick. `undefined` = o status atual continua correto. */
export function deriveRunStatus(
  current: RunStatus,
  ctx: RunTransitionContext,
): RunStatus | undefined {
  const tasks = ctx.tasks ?? []
  if (current === 'RUNNING') {
    if (isRunReadyToVerify(tasks)) return 'VERIFYING'
    if (isRunDeadlocked(tasks)) return 'BLOCKED'
    return undefined
  }
  if (current === 'BLOCKED' && !isRunDeadlocked(tasks)) return 'RUNNING'
  if (current === 'VERIFYING') return checkRunCompletion(ctx).ok ? 'COMPLETED' : undefined
  return undefined
}

export interface RunTransitionRequest {
  readonly to: RunStatus
  readonly trigger: RunTrigger
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export function applyRunTransition(
  run: Run,
  transition: RunTransitionRequest,
  ctx: RunTransitionContext = {},
): Run {
  const declared = findRunTransition(run.status, transition.to, transition.trigger)
  if (declared === undefined) {
    throw new InvalidTransitionError(
      'run',
      run.status,
      transition.to,
      transition.trigger,
      'NOT_LISTED',
    )
  }
  if (declared.guard !== undefined && !declared.guard.check(run, ctx)) {
    throw new InvalidTransitionError(
      'run',
      run.status,
      transition.to,
      transition.trigger,
      'GUARD_FAILED',
      declared.guard.name,
    )
  }

  const draft: Mutable<Run> = { ...run, status: declared.to }
  const now = ctx.now
  if (declared.to === 'APPROVED') draft.approvedAt = ctx.approval?.at ?? now ?? run.approvedAt
  if (declared.to === 'RUNNING' && run.startedAt === undefined && now !== undefined) {
    draft.startedAt = now
  }
  if (declared.to === 'COMPLETED' || declared.to === 'FAILED' || declared.to === 'CANCELLED') {
    if (now !== undefined) draft.finishedAt = now
    if (declared.to !== 'COMPLETED') draft.failureReason = ctx.reason
  }
  if (ctx.missionGateExecutionId !== undefined) {
    draft.missionGateExecutionId = ctx.missionGateExecutionId
  }
  return draft
}
