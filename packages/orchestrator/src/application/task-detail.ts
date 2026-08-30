import type {
  AgentIdentity,
  Attempt,
  CommandResult,
  DomainEvent,
  EvidenceRef,
  RunId,
  TaskId,
  TaskRun,
} from '@agentic/domain'
import { resolveTaskSettings } from '@agentic/domain'
import type {
  AgentIdentityDto,
  AttemptSummaryDto,
  CommandResultDto,
  EventDto,
  TaskDetail,
  TaskFailureDto,
} from '@agentic/schemas'
import { TaskNotFoundError } from '../engine/index.js'
import type { ApplicationDeps } from './deps.js'
import { graphViewOf } from './graph-view.js'
import { loadMissionSpec, loadRun } from './run-lifecycle.js'
import { attemptDurationMs, isoOf, toBlockageDto } from './snapshot.js'

function toIdentityDto(identity: AgentIdentity | undefined): AgentIdentityDto | undefined {
  if (identity === undefined) return undefined
  return {
    profileId: identity.profileId,
    providerId: identity.providerId,
    model: identity.model,
    sessionRef: identity.sessionRef,
    startedAt: new Date(identity.startedAt).toISOString(),
  }
}

function toCommandDto(result: CommandResult): CommandResultDto {
  return {
    command: result.command,
    cwd: result.cwd,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutRef: result.stdoutRef,
    stderrRef: result.stderrRef,
    truncated: result.truncated,
    timedOut: result.timedOut,
  }
}

function toFailureDto(attempt: Attempt | undefined): TaskFailureDto | undefined {
  const failure = attempt?.failureReason
  if (failure === undefined) return undefined
  return { failureCode: failure.code, detail: failure.detail }
}

export function toEventDto(event: DomainEvent): EventDto {
  return {
    seq: event.seq,
    ts: event.ts.toISOString(),
    type: event.type,
    actor: { kind: event.actor.kind, id: event.actor.id },
    taskId: event.taskId,
    attemptId: event.attemptId,
    payload: event.payload as Record<string, unknown>,
  }
}

function toAttemptSummary(attempt: Attempt): AttemptSummaryDto {
  const gate = attempt.gateExecutions[attempt.gateExecutions.length - 1]
  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    executor: toIdentityDto(attempt.executor),
    startedAt: attempt.startedAt.toISOString(),
    finishedAt: isoOf(attempt.finishedAt),
    durationMs: attempt.finishedAt === undefined ? undefined : attemptDurationMs(attempt),
    result: attempt.result,
    failure: toFailureDto(attempt),
    gateStatus: gate?.status,
    reviewVerdict: attempt.review?.verdict,
    worktreePath: attempt.workspace.path,
    branch: attempt.workspace.branch,
    commit: attempt.observation?.commit,
  }
}

function evidenceOf(event: DomainEvent | undefined): EvidenceRef[] {
  if (event?.type !== 'task.done') return []
  return [...event.payload.evidence]
}

/**
 * GetTaskDetail: os grupos do painel (DASHBOARD 5) montados sobre o que esta persistido —
 * grafo, escopo, execucao, revisao, isolamento, qualidade e fatos.
 */
export async function getTaskDetail(
  deps: ApplicationDeps,
  runId: RunId,
  taskId: TaskId,
): Promise<TaskDetail> {
  const run = await loadRun(deps, runId)
  const spec = run.graph.tasks.find((task) => task.id === taskId)
  if (spec === undefined) throw new TaskNotFoundError(taskId)
  const taskRuns = await deps.store.loadTaskRuns(runId)
  const byId = new Map<TaskId, TaskRun>(taskRuns.map((task) => [task.taskId, task]))
  const taskRun = byId.get(taskId)
  if (taskRun === undefined) throw new TaskNotFoundError(taskId)

  const attempts = await deps.store.loadAttempts(runId, taskId)
  const current =
    attempts.find((attempt) => attempt.id === taskRun.currentAttemptId) ??
    attempts[attempts.length - 1]
  const events = await deps.events.list(runId)
  const taskEvents = events.filter((event) => event.taskId === taskId)
  const done = taskEvents.filter((event) => event.type === 'task.done').at(-1)
  const view = graphViewOf(run.graph)
  const mission = await loadMissionSpec(deps, runId)
  const settings = resolveTaskSettings(spec, mission?.defaults ?? {})
  const gate = current?.gateExecutions[current.gateExecutions.length - 1]

  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    objective: spec.objective,
    phase: spec.phase,
    status: taskRun.status,
    graph: {
      dependencies: spec.dependencies.map((dependency) => ({
        id: dependency,
        status: byId.get(dependency)?.status ?? 'PENDING',
      })),
      dependents: run.graph.tasks
        .filter((task) => task.dependencies.includes(taskId))
        .map((task) => task.id),
      onCriticalPath: view.criticalPath.includes(taskId),
    },
    scope: {
      touches: [...spec.touches],
      reads: [...(spec.reads ?? [])],
      outOfScopePaths: [...(current?.observation?.outOfScopePaths ?? [])],
    },
    execution: {
      provider: current?.executor.providerId,
      executor: toIdentityDto(current?.executor),
      attempt:
        current === undefined
          ? undefined
          : { number: current.attemptNumber, max: settings.maxAttempts },
      startedAt: isoOf(current?.startedAt),
      durationMs: current === undefined ? undefined : attemptDurationMs(current),
    },
    review: {
      reviewer: toIdentityDto(current?.review?.reviewer),
      reviewerProvider: current?.review?.reviewer.providerId,
      policy: current?.review?.policy,
      policyOutcome: current?.review?.policyOutcome,
      verdict: current?.review?.verdict,
      findings: [...(current?.review?.findings ?? [])],
    },
    isolation: {
      kind: current?.workspace.kind,
      worktreePath: current?.workspace.path,
      branch: current?.workspace.branch,
      baseCommit: current?.workspace.baseCommit,
      commit: current?.observation?.commit,
    },
    quality: {
      validation: [...spec.validation],
      gate: settings.gate,
      gateStatus: gate?.status,
      commandResults: (gate?.results ?? []).map(toCommandDto),
    },
    facts: {
      filesChanged: [...(current?.observation?.filesChanged ?? [])],
      diffStat: current?.observation?.diffStat ?? { files: 0, added: 0, removed: 0 },
      evidence: evidenceOf(done),
    },
    failure: toFailureDto(current),
    blockage: toBlockageDto(taskRun.blockage),
    attempts: attempts.map(toAttemptSummary),
    events: taskEvents.map(toEventDto),
  }
}
