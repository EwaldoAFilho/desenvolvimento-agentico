import type {
  AgentIdentity,
  Attempt,
  DoneEvidence,
  EvidenceRef,
  Run,
  TaskRun,
  TaskStatus,
} from '../index.js'
import {
  agentProfileId,
  attemptId,
  missionId,
  pathScope,
  providerId,
  runId,
  taskId,
  taskRunId,
} from '../index.js'

export const RUN = runId('01J0000000000000000000000A')
export const MISSION = missionId('DA-CORE-001')
export const T01 = taskId('T01')
export const T02 = taskId('T02')
export const T03 = taskId('T03')

export const NOW = new Date('2026-01-01T10:00:00.000Z')

export function identity(session: string, provider = 'p-alpha', profile = 'executor'): AgentIdentity {
  return {
    profileId: agentProfileId(profile),
    providerId: providerId(provider),
    sessionRef: session,
    startedAt: NOW,
  }
}

export const EXECUTOR = identity('session-executor', 'p-alpha', 'executor')

export function taskRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    runId: RUN,
    taskId: T01,
    status: 'PENDING' as TaskStatus,
    attemptCount: 0,
    unblockedBy: [],
    ...overrides,
  }
}

export function evidenceRefs(kinds: readonly EvidenceRef['kind'][]): EvidenceRef[] {
  return kinds.map((kind) => ({ kind, sourceId: `${kind}-1`, digest: `sha256:${kind}` }))
}

export function doneEvidence(overrides: Partial<DoneEvidence> = {}): DoneEvidence {
  return {
    scopeCheck: 'PASS',
    gate: { required: true, status: 'PASS' },
    review: {
      required: true,
      verdict: 'PASS',
      reviewer: identity('session-reviewer', 'p-beta', 'reviewer'),
      policy: 'fresh-session',
      policyOutcome: 'satisfied',
    },
    executor: EXECUTOR,
    integration: 'MERGED',
    evidence: evidenceRefs(['scope', 'gate', 'review']),
    ...overrides,
  }
}

export function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: attemptId('att-1'),
    taskRunId: taskRunId(RUN, T01),
    attemptNumber: 1,
    executor: EXECUTOR,
    dispatchReason: {
      dependenciesSatisfied: [],
      locksAcquired: [pathScope('packages/domain/')],
      providerId: providerId('p-alpha'),
      slot: 'executor',
      priority: 1,
    },
    workspace: { kind: 'git-worktree', path: '/tmp/wt', branch: 'task/x' },
    startedAt: NOW,
    gateExecutions: [],
    ...overrides,
  }
}

export function run(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN,
    missionId: MISSION,
    specHash: 'sha256:spec',
    graph: { specHash: 'sha256:spec', tasks: [], edges: [], topologicalOrder: [] },
    status: 'DRAFT',
    policies: {
      maxParallelTasks: 3,
      maxExecutors: 3,
      maxReviewers: 2,
      defaultMaxAttempts: 3,
      attemptTimeoutMs: 1_800_000,
      retryBackoffMs: 15_000,
      workspaceMode: 'git-worktree',
      enforceTouches: true,
      denyPaths: ['.agentic/'],
    },
    createdAt: NOW,
    ...overrides,
  }
}
