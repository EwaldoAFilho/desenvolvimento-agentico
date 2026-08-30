import type {
  Actor,
  AgentClaims,
  AgentIdentity,
  Attempt,
  AttemptId,
  AttemptResult,
  Blockage,
  CommandResult,
  DispatchReason,
  DomainEvent,
  DomainEventInput,
  EventType,
  FailureCode,
  FrozenGraph,
  GateExecution,
  GateId,
  GateScope,
  GateStatus,
  MissionId,
  Observation,
  Review,
  ReviewFinding,
  ReviewInput,
  ReviewPolicy,
  ReviewPolicyOutcome,
  ReviewVerdict,
  Run,
  RunId,
  RunPolicies,
  RunStatus,
  TaskId,
  TaskOutcome,
  TaskRun,
  TaskStatus,
  Usage,
  WorkspaceRef,
} from '@agentic/domain'
import { parseTaskRunId, taskRunId } from '@agentic/domain'
import {
  compact,
  encodeJson,
  encodeOptionalJson,
  fromIso,
  parseJson,
  parseJsonWithDates,
  parseOptionalJson,
  parseOptionalJsonWithDates,
  toIso,
} from './json.js'
import type {
  AttemptRow,
  EventRow,
  GateExecutionRow,
  ReviewRow,
  RunRow,
  TaskRunRow,
} from './rows.js'

/**
 * Ids do dominio sao string com marca de tipo: em runtime nao ha conversao. Reaplicamos a
 * marca na leitura sem revalidar — o valor foi validado quando entrou no banco.
 */
function brand<T extends string>(value: string): T {
  return value as T
}

export function runToRow(run: Run): RunRow {
  return {
    id: run.id,
    mission_id: run.missionId,
    spec_hash: run.specHash,
    status: run.status,
    policies_json: encodeJson(run.policies),
    graph_json: encodeJson(run.graph),
    created_at: run.createdAt.toISOString(),
    approved_at: toIso(run.approvedAt),
    started_at: toIso(run.startedAt),
    finished_at: toIso(run.finishedAt),
    integration_branch: run.integrationBranch ?? null,
    mission_gate_id: run.missionGateId ?? null,
    mission_gate_execution_id: run.missionGateExecutionId ?? null,
    failure_reason: run.failureReason ?? null,
  }
}

export function rowToRun(row: RunRow): Run {
  return compact<Run>({
    id: brand<RunId>(row.id),
    missionId: brand<MissionId>(row.mission_id),
    specHash: row.spec_hash,
    graph: parseJson<FrozenGraph>(row.graph_json),
    status: row.status as RunStatus,
    policies: parseJson<RunPolicies>(row.policies_json),
    createdAt: new Date(row.created_at),
    approvedAt: fromIso(row.approved_at),
    startedAt: fromIso(row.started_at),
    finishedAt: fromIso(row.finished_at),
    missionGateId: row.mission_gate_id === null ? undefined : brand<GateId>(row.mission_gate_id),
    missionGateExecutionId: row.mission_gate_execution_id ?? undefined,
    integrationBranch: row.integration_branch ?? undefined,
    failureReason: row.failure_reason ?? undefined,
  })
}

export function taskRunToRow(taskRun: TaskRun): TaskRunRow {
  return {
    run_id: taskRun.runId,
    task_id: taskRun.taskId,
    status: taskRun.status,
    attempt_count: taskRun.attemptCount,
    current_attempt_id: taskRun.currentAttemptId ?? null,
    unblocked_by_json: encodeJson(taskRun.unblockedBy),
    ready_at: toIso(taskRun.readyAt),
    started_at: toIso(taskRun.startedAt),
    finished_at: toIso(taskRun.finishedAt),
    outcome: encodeOptionalJson(taskRun.outcome),
    blockage_json: encodeOptionalJson(taskRun.blockage),
  }
}

export function rowToTaskRun(row: TaskRunRow): TaskRun {
  return compact<TaskRun>({
    runId: brand<RunId>(row.run_id),
    taskId: brand<TaskId>(row.task_id),
    status: row.status as TaskStatus,
    attemptCount: row.attempt_count,
    currentAttemptId:
      row.current_attempt_id === null ? undefined : brand<AttemptId>(row.current_attempt_id),
    unblockedBy: parseJson<TaskId[]>(row.unblocked_by_json),
    readyAt: fromIso(row.ready_at),
    startedAt: fromIso(row.started_at),
    finishedAt: fromIso(row.finished_at),
    blockage: parseOptionalJsonWithDates<Blockage>(row.blockage_json),
    outcome: parseOptionalJson<TaskOutcome>(row.outcome),
  })
}

export function attemptToRow(attempt: Attempt): AttemptRow {
  const { run, task } = parseTaskRunId(attempt.taskRunId)
  return {
    id: attempt.id,
    run_id: run,
    task_id: task,
    attempt_number: attempt.attemptNumber,
    executor_json: encodeJson(attempt.executor),
    dispatch_reason_json: encodeJson(attempt.dispatchReason),
    workspace_json: encodeJson(attempt.workspace),
    started_at: attempt.startedAt.toISOString(),
    finished_at: toIso(attempt.finishedAt),
    duration_ms: attempt.durationMs ?? null,
    result: attempt.result ?? null,
    failure_code: attempt.failureReason?.code ?? null,
    failure_detail: attempt.failureReason?.detail ?? null,
    claims_json: encodeOptionalJson(attempt.claims),
    observation_json: encodeOptionalJson(attempt.observation),
    usage_json: encodeOptionalJson(attempt.usage),
  }
}

export function rowToAttempt(
  row: AttemptRow,
  gateExecutions: readonly GateExecution[] = [],
  review?: Review,
): Attempt {
  const failure =
    row.failure_code === null
      ? undefined
      : compact({
          code: row.failure_code as FailureCode,
          detail: row.failure_detail ?? undefined,
        })
  return compact<Attempt>({
    id: brand<AttemptId>(row.id),
    taskRunId: taskRunId(brand<RunId>(row.run_id), brand<TaskId>(row.task_id)),
    attemptNumber: row.attempt_number,
    executor: parseJsonWithDates<AgentIdentity>(row.executor_json),
    dispatchReason: parseJson<DispatchReason>(row.dispatch_reason_json),
    workspace: parseJson<WorkspaceRef>(row.workspace_json),
    startedAt: new Date(row.started_at),
    finishedAt: fromIso(row.finished_at),
    durationMs: row.duration_ms ?? undefined,
    claims: parseOptionalJson<AgentClaims>(row.claims_json),
    observation: parseOptionalJson<Observation>(row.observation_json),
    gateExecutions,
    review,
    result: row.result === null ? undefined : (row.result as AttemptResult),
    failureReason: failure,
    usage: parseOptionalJson<Usage>(row.usage_json),
  })
}

export function gateExecutionToRow(execution: GateExecution): GateExecutionRow {
  return {
    id: execution.id,
    run_id: execution.runId,
    scope: execution.scope,
    gate_id: execution.gateId,
    attempt_id: execution.attemptId ?? null,
    status: execution.status,
    started_at: execution.startedAt.toISOString(),
    finished_at: toIso(execution.finishedAt),
    results_json: encodeJson(execution.results),
  }
}

export function rowToGateExecution(row: GateExecutionRow): GateExecution {
  return compact<GateExecution>({
    id: row.id,
    gateId: brand<GateId>(row.gate_id),
    scope: row.scope as GateScope,
    runId: brand<RunId>(row.run_id),
    attemptId: row.attempt_id === null ? undefined : brand<AttemptId>(row.attempt_id),
    startedAt: new Date(row.started_at),
    finishedAt: fromIso(row.finished_at),
    status: row.status as GateStatus,
    results: parseJson<CommandResult[]>(row.results_json),
  })
}

export function reviewToRow(review: Review): ReviewRow {
  return {
    id: review.id,
    attempt_id: review.attemptId,
    reviewer_json: encodeJson(review.reviewer),
    verdict: review.verdict,
    findings_json: encodeJson(review.findings),
    rationale: review.rationale,
    duration_ms: review.durationMs,
    input_json: encodeJson(review.input),
    policy: review.policy,
    policy_outcome: review.policyOutcome,
    policy_outcome_reason: review.policyOutcomeReason ?? null,
  }
}

export function rowToReview(row: ReviewRow): Review {
  return compact<Review>({
    id: row.id,
    attemptId: brand<AttemptId>(row.attempt_id),
    reviewer: parseJsonWithDates<AgentIdentity>(row.reviewer_json),
    input: parseJson<ReviewInput>(row.input_json),
    verdict: row.verdict as ReviewVerdict,
    findings: parseJson<ReviewFinding[]>(row.findings_json),
    rationale: row.rationale,
    durationMs: row.duration_ms,
    policy: row.policy as ReviewPolicy,
    policyOutcome: row.policy_outcome as ReviewPolicyOutcome,
    policyOutcomeReason: row.policy_outcome_reason ?? undefined,
  })
}

export function eventToInsertRow(event: DomainEventInput): Omit<EventRow, 'seq'> {
  return {
    run_id: event.runId,
    ts: event.ts.toISOString(),
    type: event.type,
    actor: encodeJson(event.actor),
    task_id: event.taskId ?? null,
    attempt_id: event.attemptId ?? null,
    payload_json: encodeJson(event.payload),
  }
}

export function eventToRow(event: DomainEventInput, seq: number): EventRow {
  return { seq, ...eventToInsertRow(event) }
}

/** O payload e uniao discriminada por `type`: a linha volta como o mesmo tipo que entrou. */
export function rowToEvent(row: EventRow): DomainEvent {
  return compact({
    seq: row.seq,
    runId: brand<RunId>(row.run_id),
    ts: new Date(row.ts),
    type: row.type as EventType,
    actor: parseJson<Actor>(row.actor),
    taskId: row.task_id === null ? undefined : brand<TaskId>(row.task_id),
    attemptId: row.attempt_id === null ? undefined : brand<AttemptId>(row.attempt_id),
    payload: parseJsonWithDates(row.payload_json),
  }) as DomainEvent
}
