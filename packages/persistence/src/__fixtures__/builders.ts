import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentIdentity,
  Attempt,
  Blockage,
  CommandResult,
  DomainEventInput,
  GateExecution,
  Review,
  Run,
  TaskRun,
  TaskSpec,
} from '@agentic/domain'
import {
  agentProfileId,
  attemptId,
  gateId,
  missionId,
  pathScope,
  phaseId,
  providerId,
  runId,
  taskId,
  taskRunId,
} from '@agentic/domain'
import { openPersistence, type Persistence } from '../persistence.js'

export const RUN = runId('01J0000000000000000000000A')
export const RUN_B = runId('01J0000000000000000000000B')
/** Run que nunca e criado: usado para provocar violacao de chave estrangeira. */
export const MISSING_RUN = runId('01J0000000000000000000000C')
export const MISSION = missionId('DA-CORE-001')
export const T01 = taskId('T01')
export const T02 = taskId('T02')

export const NOW = new Date('2026-08-30T12:47:31.123Z')
export const LATER = new Date('2026-08-30T13:02:07.456Z')

export function identity(session: string, provider = 'p-alpha', profile = 'executor'): AgentIdentity {
  return {
    profileId: agentProfileId(profile),
    providerId: providerId(provider),
    model: 'model-x',
    sessionRef: session,
    startedAt: NOW,
    runtime: { handle: `h-${session}`, pid: 4242, cwd: '/tmp/wt', startedAt: NOW },
  }
}

export const EXECUTOR = identity('session-executor', 'p-alpha', 'executor')
export const REVIEWER = identity('session-reviewer', 'p-beta', 'reviewer')

export function taskSpec(id = T01, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    phase: phaseId('foundation'),
    title: `Task ${id}`,
    objective: 'objetivo mensuravel',
    description: 'descricao longa',
    dependencies: [],
    touches: [pathScope('packages/persistence/')],
    reads: [pathScope('docs/')],
    validation: ['gate passa', 'testes verdes'],
    gate: gateId('core'),
    requireReview: true,
    maxAttempts: 3,
    risk: 'high',
    estimate: 5,
    agentProfile: agentProfileId('executor'),
    reviewPolicy: 'cross-provider-required',
    ...overrides,
  }
}

export function run(overrides: Partial<Run> = {}): Run {
  const tasks = [taskSpec(T01), taskSpec(T02, { dependencies: [T01] })]
  return {
    id: RUN,
    missionId: MISSION,
    specHash: 'sha256:spec-hash',
    graph: {
      specHash: 'sha256:spec-hash',
      tasks,
      edges: [{ from: T01, to: T02 }],
      topologicalOrder: [T01, T02],
    },
    status: 'RUNNING',
    policies: {
      maxParallelTasks: 3,
      maxExecutors: 3,
      maxReviewers: 2,
      defaultMaxAttempts: 3,
      attemptTimeoutMs: 1_800_000,
      retryBackoffMs: 15_000,
      workspaceMode: 'git-worktree',
      enforceTouches: true,
      denyPaths: ['.agentic/', 'node_modules/'],
    },
    createdAt: NOW,
    approvedAt: NOW,
    startedAt: NOW,
    ...overrides,
  }
}

export function taskRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    runId: RUN,
    taskId: T01,
    status: 'PENDING',
    attemptCount: 0,
    unblockedBy: [],
    ...overrides,
  }
}

export function blockage(): Blockage {
  return {
    kind: 'ARCHITECTURAL',
    reason: 'contrato ambiguo entre pacotes',
    raisedBy: 'session-executor',
    raisedAt: NOW,
    needs: 'decisao humana sobre o formato do DTO',
    resolvedAt: LATER,
    resolution: 'ADR-0007 aprovada',
  }
}

export function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command: 'npm run build -w @agentic/persistence',
    cwd: '/repo',
    exitCode: 0,
    durationMs: 4321,
    stdoutRef: 'runs/x/gate-core.stdout',
    stderrRef: 'runs/x/gate-core.stderr',
    truncated: false,
    timedOut: false,
    ...overrides,
  }
}

export function gateExecution(overrides: Partial<GateExecution> = {}): GateExecution {
  return {
    id: 'gx-1',
    gateId: gateId('core'),
    scope: 'task',
    runId: RUN,
    attemptId: attemptId('att-1'),
    startedAt: NOW,
    finishedAt: LATER,
    status: 'PASS',
    results: [commandResult(), commandResult({ command: 'npx vitest run', exitCode: 1 })],
    ...overrides,
  }
}

export function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 'rv-1',
    attemptId: attemptId('att-1'),
    reviewer: REVIEWER,
    input: {
      objective: 'validar persistencia',
      validation: ['I1 coberto', 'WAL testado'],
      constraints: ['sem alterar dominio'],
      touches: [pathScope('packages/persistence/')],
      diffRef: 'runs/x/patch.diff',
      gateExecutionIds: ['gx-1'],
      gateIds: [gateId('core')],
    },
    verdict: 'PASS',
    findings: [
      { severity: 'warning', path: 'packages/persistence/src/x.ts', line: 12, message: 'nit' },
      {
        severity: 'info',
        message: 'ok',
        evidenceRef: { kind: 'gate', sourceId: 'gx-1', digest: 'sha256:abc' },
      },
    ],
    rationale: 'evidencia bate com o contrato',
    durationMs: 9876,
    policy: 'cross-provider-required',
    policyOutcome: 'satisfied',
    policyOutcomeReason: 'revisor de outro provider disponivel',
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
      dependenciesSatisfied: [T01],
      locksAcquired: [pathScope('packages/persistence/')],
      providerId: providerId('p-alpha'),
      slot: 'executor',
      priority: 7,
      note: 'primeira onda',
    },
    workspace: {
      kind: 'git-worktree',
      path: '.agentic/worktrees/run/T01-a1',
      branch: 'task/T01-a1',
      baseCommit: 'abc123',
    },
    startedAt: NOW,
    gateExecutions: [],
    ...overrides,
  }
}

export function closedAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return attempt({
    finishedAt: LATER,
    durationMs: 876_333,
    claims: {
      summary: 'implementei a persistencia',
      detail: 'relato do agente, nunca fato',
      reportedFiles: ['packages/persistence/src/index.ts'],
    },
    observation: {
      filesChanged: [
        { path: 'packages/persistence/src/index.ts', change: 'M', added: 12, removed: 3 },
        {
          path: 'packages/persistence/src/run-store.ts',
          change: 'R',
          added: 4,
          removed: 0,
          renamedFrom: 'packages/persistence/src/store.ts',
        },
      ],
      diffStat: { files: 2, added: 16, removed: 3 },
      diffRef: 'runs/x/patch.diff',
      outOfScopePaths: ['packages/domain/src/run.ts'],
      commit: 'def456',
      scopeCheck: 'VIOLATION',
    },
    result: 'FAIL',
    failureReason: { code: 'SCOPE_VIOLATION', detail: 'escreveu fora de touches' },
    usage: { model: 'model-x', inputTokens: 1234, outputTokens: 567, costUsd: 0.42 },
    ...overrides,
  })
}

export function event(overrides: Partial<DomainEventInput> = {}): DomainEventInput {
  return {
    runId: RUN,
    ts: NOW,
    type: 'run.started',
    actor: { kind: 'orchestrator', id: 'engine' },
    payload: { warningsAccepted: true },
    ...overrides,
  } as DomainEventInput
}

export interface TempPersistence {
  readonly dir: string
  readonly persistence: Persistence
  dispose(): Promise<void>
}

export async function tempPersistence(): Promise<TempPersistence> {
  const dir = await mkdtemp(join(tmpdir(), 'agentic-persistence-'))
  const persistence = openPersistence({ baseDir: dir, pollIntervalMs: 10 })
  return {
    dir,
    persistence,
    dispose: async (): Promise<void> => {
      persistence.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agentic-persistence-'))
}

export async function seededRun(persistence: Persistence, source: Run = run()): Promise<Run> {
  await persistence.runs.createRun(source, [
    taskRun({ runId: source.id, taskId: T01 }),
    taskRun({ runId: source.id, taskId: T02 }),
  ])
  return source
}
