import type {
  DispatchContext,
  ExecuteAssignment,
  GateExecution,
  ReviewAssignment,
  Workspace,
} from '@agentic/domain'
import { attemptId, gateId, missionId, pathScope, runId, taskId } from '@agentic/domain'

export const MISSION = missionId('DA-CORE-001')
export const RUN = runId('01J0000000000000000000000A')
export const TASK = taskId('T09')
export const ATTEMPT = attemptId('T09-a1')

export function workspace(path: string): Workspace {
  return { id: 'ws-t09-a1', kind: 'git-worktree', path, branch: 'task/DA-CORE-001/T09/a1', leasedBy: ATTEMPT }
}

export function executeAssignment(
  workspacePath: string,
  overrides: Partial<ExecuteAssignment> = {},
): ExecuteAssignment {
  return {
    kind: 'execute',
    missionId: MISSION,
    runId: RUN,
    taskId: TASK,
    attemptId: ATTEMPT,
    objective: 'Implementar os adapters de AgentProvider',
    description: 'Tres adapters sobre a mesma porta, validados pela mesma suite.',
    constraints: ['nenhum adapter pode exigir API key'],
    touches: [pathScope('packages/providers/')],
    reads: [pathScope('packages/domain/')],
    denyPaths: ['.agentic/', '.env'],
    satisfiedDependencies: [taskId('T17')],
    validation: ['suite de contrato passa nos tres adapters'],
    workspacePath,
    timeoutMs: 15_000,
    ...overrides,
  }
}

export function gateExecution(): GateExecution {
  return {
    id: 'gate-exec-1',
    gateId: gateId('unit'),
    scope: 'task',
    runId: RUN,
    attemptId: ATTEMPT,
    startedAt: new Date('2026-01-01T10:00:00.000Z'),
    finishedAt: new Date('2026-01-01T10:01:00.000Z'),
    status: 'PASS',
    results: [
      {
        command: 'npx vitest run --project providers',
        cwd: '/w',
        exitCode: 0,
        durationMs: 4200,
        truncated: false,
      },
    ],
  }
}

export function reviewAssignment(
  workspacePath: string,
  overrides: Partial<ReviewAssignment> = {},
): ReviewAssignment {
  const base = executeAssignment(workspacePath)
  return {
    ...base,
    kind: 'review',
    diffRef: 'diff:sha256-abc123',
    gateExecutions: [gateExecution()],
    policy: 'cross-provider-required',
    ...overrides,
  }
}

export function dispatchContext(
  workspacePath: string,
  overrides: Partial<DispatchContext> = {},
): DispatchContext {
  return {
    runId: RUN,
    taskId: TASK,
    attemptId: ATTEMPT,
    workspace: workspace(workspacePath),
    timeoutMs: 15_000,
    env: {},
    ...overrides,
  }
}
