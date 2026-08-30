import type { GateId, MissionId, RunId, TaskId } from './ids.js'
import type { Dependency, TaskSpec } from './mission.js'

export const RUN_STATUSES = [
  'DRAFT',
  'APPROVED',
  'RUNNING',
  'PAUSED',
  'BLOCKED',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const TERMINAL_RUN_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value)
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
}

export interface RunPolicies {
  readonly maxParallelTasks: number
  readonly maxExecutors: number
  readonly maxReviewers: number
  readonly defaultMaxAttempts: number
  readonly attemptTimeoutMs: number
  readonly retryBackoffMs: number
  readonly workspaceMode: 'shared' | 'git-worktree'
  readonly enforceTouches: boolean
  /** Padroes de caminho negados; podem conter glob, por isso sao strings cruas. */
  readonly denyPaths: readonly string[]
}

/**
 * Grafo congelado no inicio do run: alterar o arquivo da missao durante a execucao nao muda
 * o run corrente. O formato completo (`CompiledGraph`) e produzido pelo compilador; o
 * dominio depende apenas desta forma minima.
 */
export interface FrozenGraph {
  readonly specHash: string
  readonly tasks: readonly TaskSpec[]
  readonly edges: readonly Dependency[]
  readonly topologicalOrder: readonly TaskId[]
}

export interface Run {
  readonly id: RunId
  readonly missionId: MissionId
  readonly specHash: string
  readonly graph: FrozenGraph
  readonly status: RunStatus
  readonly policies: RunPolicies
  readonly createdAt: Date
  readonly approvedAt?: Date
  readonly startedAt?: Date
  readonly finishedAt?: Date
  readonly missionGateId?: GateId
  readonly missionGateExecutionId?: string
  readonly integrationBranch?: string
  readonly failureReason?: string
}
