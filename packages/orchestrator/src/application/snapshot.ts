import type { Attempt, Blockage, ProviderHealth, RunId, TaskRun, TaskStatus } from '@agentic/domain'
import { TASK_STATUSES } from '@agentic/domain'
import type {
  BlockageDto,
  ProviderHealthDto,
  RunSnapshot,
  TaskCountersDto,
  TaskSnapshotDto,
} from '@agentic/schemas'
import type { ApplicationDeps } from './deps.js'
import { graphViewOf } from './graph-view.js'
import { loadRun } from './run-lifecycle.js'

export function isoOf(value: Date | undefined): string | undefined {
  return value === undefined ? undefined : value.toISOString()
}

export function toBlockageDto(blockage: Blockage | undefined): BlockageDto | undefined {
  if (blockage === undefined) return undefined
  return {
    kind: blockage.kind,
    reason: blockage.reason,
    raisedBy: blockage.raisedBy,
    raisedAt: new Date(blockage.raisedAt).toISOString(),
    needs: blockage.needs,
    resolvedAt:
      blockage.resolvedAt === undefined ? undefined : new Date(blockage.resolvedAt).toISOString(),
    resolution: blockage.resolution,
  }
}

export function toProviderHealthDto(health: ProviderHealth): ProviderHealthDto {
  return {
    providerId: health.providerId,
    installed: health.installed,
    ready: health.ready,
    version: health.version,
    detail: health.detail,
    running: health.running,
    capacity: health.capacity,
    probedAt: health.probedAt.toISOString(),
  }
}

function countersOf(tasks: readonly TaskRun[]): TaskCountersDto {
  const counters = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
    TaskStatus,
    number
  >
  for (const task of tasks) counters[task.status] += 1
  return counters
}

function durationOf(task: TaskRun): number | undefined {
  if (task.startedAt === undefined || task.finishedAt === undefined) return undefined
  return Math.max(0, task.finishedAt.getTime() - task.startedAt.getTime())
}

function toTaskSnapshot(task: TaskRun): TaskSnapshotDto {
  return {
    id: task.taskId,
    status: task.status,
    attemptCount: task.attemptCount,
    currentAttempt: task.currentAttemptId,
    unblockedBy: [...task.unblockedBy],
    blockage: toBlockageDto(task.blockage),
    readyAt: isoOf(task.readyAt),
    startedAt: isoOf(task.startedAt),
    finishedAt: isoOf(task.finishedAt),
    durationMs: durationOf(task),
  }
}

export function attemptDurationMs(attempt: Attempt): number {
  if (attempt.durationMs !== undefined) return attempt.durationMs
  if (attempt.finishedAt === undefined) return 0
  return Math.max(0, attempt.finishedAt.getTime() - attempt.startedAt.getTime())
}

/**
 * GetRunSnapshot: cabecalho + geometria congelada + estado por task. O dashboard aplica os
 * eventos sobre este retrato — nada aqui recompila nem consulta agente.
 */
export async function getRunSnapshot(deps: ApplicationDeps, runId: RunId): Promise<RunSnapshot> {
  const run = await loadRun(deps, runId)
  const tasks = await deps.store.loadTaskRuns(runId)
  const attempts = await deps.store.loadAttempts(runId)
  const view = graphViewOf(run.graph)
  const health = await deps.registry.health()

  const started = run.startedAt ?? run.createdAt
  const finished = run.finishedAt ?? deps.clock.now()
  const wallTimeMs = Math.max(0, finished.getTime() - started.getTime())
  const busyMs = attempts.reduce((sum, attempt) => sum + attemptDurationMs(attempt), 0)

  return {
    run: {
      id: run.id,
      missionId: run.missionId,
      status: run.status,
      timestamps: {
        createdAt: run.createdAt.toISOString(),
        approvedAt: isoOf(run.approvedAt),
        startedAt: isoOf(run.startedAt),
        finishedAt: isoOf(run.finishedAt),
      },
      policies: {
        maxParallelTasks: run.policies.maxParallelTasks,
        maxExecutors: run.policies.maxExecutors,
        maxReviewers: run.policies.maxReviewers,
        defaultMaxAttempts: run.policies.defaultMaxAttempts,
        attemptTimeoutMs: run.policies.attemptTimeoutMs,
        retryBackoffMs: run.policies.retryBackoffMs,
        workspaceMode: run.policies.workspaceMode,
        enforceTouches: run.policies.enforceTouches,
        denyPaths: [...run.policies.denyPaths],
      },
      missionGate: run.missionGateId,
      integrationBranch: run.integrationBranch,
    },
    graph: {
      nodes: run.graph.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        phase: task.phase,
        dependencies: [...task.dependencies],
        touches: [...task.touches],
        risk: task.risk,
        estimate: task.estimate ?? 1,
      })),
      edges: run.graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
      waves: view.waves.map((wave) => [...wave]),
      criticalPath: [...view.criticalPath],
      slack: view.slack,
    },
    tasks: tasks.map(toTaskSnapshot),
    counters: countersOf(tasks),
    providers: health.map(toProviderHealthDto),
    metrics: {
      wallTimeMs,
      attempts: attempts.length,
      retries: tasks.reduce((sum, task) => sum + Math.max(0, task.attemptCount - 1), 0),
      reviewFailures: attempts.filter((attempt) => attempt.failureReason?.code === 'REVIEW_FAILED')
        .length,
      parallelismRatio: wallTimeMs === 0 ? 0 : busyMs / wallTimeMs,
    },
  }
}
