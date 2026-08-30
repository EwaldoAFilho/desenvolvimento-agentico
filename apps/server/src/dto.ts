import type { Run, RunId, TaskId } from '@agentic/domain'
import { isRunId, isTaskId } from '@agentic/domain'
import { isoOf } from '@agentic/orchestrator'
import type { RunHeaderDto } from '@agentic/schemas'
import { notFound } from './errors.js'

/**
 * Cabecalho do run no contrato publico. Traducao pura: o servidor nao deriva estado, so
 * troca `Date` por ISO-8601 e entrega o que o orquestrador ja gravou.
 */
export function toRunHeader(run: Run): RunHeaderDto {
  return {
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
  }
}

/** Id fora do formato nao existe: 404, nunca 500 com stack de validacao de id. */
export function parseRunId(raw: string): RunId {
  if (!isRunId(raw)) throw notFound('RUN_NOT_FOUND', `run ${raw} nao existe`)
  return raw
}

export function parseTaskId(raw: string): TaskId {
  if (!isTaskId(raw)) throw notFound('TASK_NOT_FOUND', `task ${raw} nao existe neste run`)
  return raw
}
