import type { Run, RunId, TaskId, TaskRun, TaskStatus } from '@agentic/domain'
import { isRunId, isTaskId, TASK_STATUSES } from '@agentic/domain'
import { isoOf } from '@agentic/orchestrator'
import type { RunHeaderDto, RunSummaryDto, TaskCountersDto } from '@agentic/schemas'
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

/**
 * Contadores por estado das tasks de um run. `undefined` quando nao ha nenhuma task run
 * gravada: o contrato pede ausencia, e nao uma linha de zeros que parece apuracao feita.
 */
export function toTaskCounters(tasks: readonly TaskRun[]): TaskCountersDto | undefined {
  if (tasks.length === 0) return undefined
  const counters = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
    TaskStatus,
    number
  >
  for (const task of tasks) counters[task.status] += 1
  return counters
}

/**
 * Execucao vista de fora, para listagem. Mesma traducao pura do cabecalho — `Date` vira
 * ISO-8601 e nada e derivado aqui: quem conta as tasks e o banco, nao esta funcao.
 */
export function toRunSummary(run: Run, counters?: TaskCountersDto): RunSummaryDto {
  const startedAt = isoOf(run.startedAt)
  const finishedAt = isoOf(run.finishedAt)
  return {
    id: run.id,
    missionId: run.missionId,
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(counters === undefined ? {} : { counters }),
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
