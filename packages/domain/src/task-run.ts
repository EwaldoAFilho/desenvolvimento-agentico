import type { FailureCode } from './failure-codes.js'
import type { AttemptId, RunId, TaskId } from './ids.js'

export const TASK_STATUSES = [
  'PENDING',
  'READY',
  'RUNNING',
  'VERIFYING',
  'REVIEW',
  'INTEGRATING',
  'DONE',
  'FAILED',
  'RETRY',
  'BLOCKED',
  'SKIPPED',
  'CANCELLED',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TERMINAL_TASK_STATUSES = ['DONE', 'SKIPPED', 'CANCELLED'] as const
/** Estados que contam como "a task ainda pode progredir sozinha" (RUN 2.3). */
export const PROGRESSING_TASK_STATUSES = [
  'READY',
  'RUNNING',
  'VERIFYING',
  'REVIEW',
  'INTEGRATING',
  'RETRY',
] as const
export const SETTLED_TASK_STATUSES = ['DONE', 'SKIPPED', 'CANCELLED'] as const

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status)
}

export function isProgressingTaskStatus(status: TaskStatus): boolean {
  return (PROGRESSING_TASK_STATUSES as readonly string[]).includes(status)
}

export const BLOCKAGE_KINDS = [
  'ARCHITECTURAL',
  'DEPENDENCY',
  'POLICY',
  'ATTEMPTS_EXHAUSTED',
  'EXTERNAL',
] as const
export type BlockageKind = (typeof BLOCKAGE_KINDS)[number]

/** BLOCKED e estado de primeira classe: nada fica fingindo RUNNING a espera de humano (P11). */
export interface Blockage {
  readonly kind: BlockageKind
  readonly reason: string
  readonly raisedBy: string
  readonly raisedAt: Date
  readonly needs: string
  readonly resolvedAt?: Date
  readonly resolution?: string
}

export type TaskOutcomeKind = 'DONE' | 'FAILED' | 'SKIPPED' | 'CANCELLED'

export interface TaskOutcome {
  readonly kind: TaskOutcomeKind
  readonly reason?: string
  readonly failureCode?: FailureCode
}

export interface TaskRun {
  readonly runId: RunId
  readonly taskId: TaskId
  readonly status: TaskStatus
  readonly attemptCount: number
  readonly currentAttemptId?: AttemptId
  /** Auditoria de "por que agora?": dependencias cuja conclusao liberou esta task. */
  readonly unblockedBy: readonly TaskId[]
  readonly readyAt?: Date
  readonly startedAt?: Date
  readonly finishedAt?: Date
  readonly blockage?: Blockage
  readonly outcome?: TaskOutcome
}

/** Transicao 1: criacao do run. Toda task nasce PENDING. */
export function createTaskRun(runId: RunId, taskId: TaskId): TaskRun {
  return { runId, taskId, status: 'PENDING', attemptCount: 0, unblockedBy: [] }
}
