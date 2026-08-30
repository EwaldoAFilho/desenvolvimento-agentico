import type {
  AgentIdentity,
  AgentProfile,
  CapacitySnapshot,
  Dependency,
  FrozenGraph,
  RunPolicies,
  TaskRun,
  TaskSpec,
  TaskStatus,
} from '@agentic/domain'
import {
  agentProfileId,
  attemptId,
  pathScope,
  phaseId,
  providerId,
  runId,
  taskId,
} from '@agentic/domain'
import type { PendingReview, SchedulerInput } from '../types.js'

export const RUN = runId('01J0000000000000000000000A')
export const NOW = new Date('2026-01-01T10:00:00.000Z')

/** Ids de provider sao opacos e vem de configuracao (P18): nenhum nome de fornecedor. */
export const ALPHA = providerId('p-alpha')
export const BETA = providerId('p-beta')
export const GAMMA = providerId('p-gamma')

export const T = (raw: string) => taskId(raw)

export function spec(id: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: taskId(id),
    phase: phaseId('build'),
    title: `task ${id}`,
    objective: `objetivo ${id}`,
    dependencies: [],
    touches: [pathScope(`packages/${id.toLowerCase()}/`)],
    validation: [],
    risk: 'medium',
    ...overrides,
  }
}

export function graphOf(tasks: readonly TaskSpec[], order?: readonly string[]): FrozenGraph {
  const edges: Dependency[] = []
  for (const task of tasks) {
    for (const from of task.dependencies) edges.push({ from, to: task.id })
  }
  return {
    specHash: 'sha256:spec',
    tasks,
    edges,
    topologicalOrder: (order ?? tasks.map((task) => task.id as string)).map(taskId),
  }
}

export function specsOf(tasks: readonly TaskSpec[]): Map<TaskSpec['id'], TaskSpec> {
  return new Map(tasks.map((task) => [task.id, task]))
}

export function taskRun(id: string, status: TaskStatus = 'READY'): TaskRun {
  return { runId: RUN, taskId: taskId(id), status, attemptCount: 0, unblockedBy: [] }
}

export function identity(session: string, provider = ALPHA, profile = 'reviewer'): AgentIdentity {
  return {
    profileId: agentProfileId(profile),
    providerId: provider,
    sessionRef: session,
    startedAt: NOW,
  }
}

export function profile(id: string, provider = ALPHA): AgentProfile {
  return {
    id: agentProfileId(id),
    role: 'executor',
    providerId: provider,
    tags: [],
  }
}

export function pending(id: string, executor: AgentIdentity): PendingReview {
  return { taskId: taskId(id), attemptId: attemptId(`att-${id}`), executor }
}

export function policies(overrides: Partial<RunPolicies> = {}): RunPolicies {
  return {
    maxParallelTasks: 4,
    maxExecutors: 4,
    maxReviewers: 4,
    defaultMaxAttempts: 3,
    attemptTimeoutMs: 1_800_000,
    retryBackoffMs: 15_000,
    workspaceMode: 'git-worktree',
    enforceTouches: true,
    denyPaths: ['.agentic/'],
    ...overrides,
  }
}

export interface CapacityOverrides {
  readonly global?: Partial<CapacitySnapshot['global']>
  readonly executor?: Partial<CapacitySnapshot['executor']>
  readonly reviewer?: Partial<CapacitySnapshot['reviewer']>
  readonly byProvider?: Record<string, { maxConcurrent: number; running: number }>
}

export function capacity(overrides: CapacityOverrides = {}): CapacitySnapshot {
  return {
    global: { maxParallelTasks: 4, active: 0, ...overrides.global },
    executor: { max: 4, active: 0, ...overrides.executor },
    reviewer: { max: 4, active: 0, ...overrides.reviewer },
    byProvider: overrides.byProvider ?? {
      [ALPHA]: { maxConcurrent: 4, running: 0 },
      [BETA]: { maxConcurrent: 4, running: 0 },
      [GAMMA]: { maxConcurrent: 4, running: 0 },
    },
  }
}

const DEFAULT_TASKS = [spec('T01'), spec('T02')]

export function input(overrides: Partial<SchedulerInput> = {}): SchedulerInput {
  const tasks = overrides.graph?.tasks ?? DEFAULT_TASKS
  return {
    graph: graphOf(tasks),
    tasks: tasks.map((task) => taskRun(task.id)),
    specs: specsOf(tasks),
    runStatus: 'RUNNING',
    policies: policies(),
    capacity: capacity(),
    locks: [],
    executorCandidates: [profile('executor-alpha', ALPHA)],
    reviewCandidates: [],
    pendingReviews: [],
    projectReviewPolicy: { default: 'fresh-session' },
    now: NOW,
    ...overrides,
  }
}

/** Embaralhamento deterministico: reordena sem depender de aleatoriedade. */
export function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = (i * 7 + 3) % (i + 1)
    const a = out[i]
    const b = out[j]
    if (a === undefined || b === undefined) continue
    out[i] = b
    out[j] = a
  }
  return out
}
