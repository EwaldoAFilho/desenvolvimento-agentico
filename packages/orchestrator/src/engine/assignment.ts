import type {
  AttemptId,
  ExecuteAssignment,
  GateExecution,
  MissionSpec,
  ReviewAssignment,
  ReviewPolicy,
  Run,
  TaskId,
  TaskSpec,
} from '@agentic/domain'

export interface AssignmentContext {
  readonly mission: MissionSpec
  readonly run: Run
  readonly spec: TaskSpec
  readonly attemptId: AttemptId
  readonly workspacePath: string
  readonly satisfiedDependencies: readonly TaskId[]
  readonly timeoutMs: number
}

/** Contexto minimo suficiente (P14): objetivo, escopo, deps satisfeitas e validacao. */
function base(context: AssignmentContext): Omit<ExecuteAssignment, 'kind'> {
  const { mission, run, spec } = context
  return {
    missionId: mission.id,
    runId: run.id,
    taskId: spec.id,
    attemptId: context.attemptId,
    objective: spec.objective,
    description: spec.description,
    constraints: mission.constraints,
    touches: spec.touches,
    reads: spec.reads ?? [],
    denyPaths: run.policies.denyPaths,
    satisfiedDependencies: context.satisfiedDependencies,
    validation: spec.validation,
    workspacePath: context.workspacePath,
    timeoutMs: context.timeoutMs,
  }
}

export function buildExecuteAssignment(context: AssignmentContext): ExecuteAssignment {
  return { ...base(context), kind: 'execute' }
}

export interface ReviewAssignmentContext extends AssignmentContext {
  readonly diffRef: string
  readonly gateExecutions: readonly GateExecution[]
  readonly policy: ReviewPolicy
}

/**
 * P07 / anti-vies: o revisor recebe contrato, diff e resultados de gate. A narrativa do
 * executor (`AgentOutcome.claims`) NAO entra aqui — nem existe campo para ela no contrato.
 */
export function buildReviewAssignment(context: ReviewAssignmentContext): ReviewAssignment {
  return {
    ...base(context),
    kind: 'review',
    diffRef: context.diffRef,
    gateExecutions: context.gateExecutions,
    policy: context.policy,
  }
}
