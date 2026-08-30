import type { Attempt, GateExecution, MissionSpec, Run, TaskSpec } from '@agentic/domain'
import {
  pathScope,
  phaseId,
  attemptId as toAttemptId,
  missionId as toMissionId,
  runId as toRunId,
  taskId as toTaskId,
} from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import { buildExecuteAssignment, buildReviewAssignment } from './assignment.js'
import { SharedTreeIntegrator } from './integration.js'

const RUN = toRunId('01J0000000000000000000000A')

const spec: TaskSpec = {
  id: toTaskId('T04'),
  phase: phaseId('build'),
  title: 'implementar o motor',
  objective: 'motor com prova',
  description: 'contexto extra',
  dependencies: [toTaskId('T01')],
  touches: [pathScope('packages/engine/')],
  reads: [pathScope('docs/')],
  validation: ['o gate passa'],
  risk: 'medium',
}

const mission: MissionSpec = {
  id: toMissionId('DA-TEST-001'),
  title: 'missao',
  objective: 'objetivo',
  scope: [],
  outOfScope: [],
  constraints: ['sem dependencia nova'],
  acceptanceCriteria: ['tudo verde'],
  defaults: {},
  phases: [{ id: phaseId('build'), title: 'Build' }],
  tasks: [spec],
}

const run: Run = {
  id: RUN,
  missionId: mission.id,
  specHash: 'fnv1a64:0',
  graph: { specHash: 'fnv1a64:0', tasks: [spec], edges: [], topologicalOrder: [spec.id] },
  status: 'RUNNING',
  policies: {
    maxParallelTasks: 2,
    maxExecutors: 2,
    maxReviewers: 1,
    defaultMaxAttempts: 3,
    attemptTimeoutMs: 1000,
    retryBackoffMs: 0,
    workspaceMode: 'git-worktree',
    enforceTouches: true,
    denyPaths: ['.agentic/'],
  },
  createdAt: new Date(0),
}

const context = {
  mission,
  run,
  spec,
  attemptId: toAttemptId('T04-a1-x'),
  workspacePath: '/tmp/worktrees/T04-a1',
  satisfiedDependencies: [toTaskId('T01')],
  timeoutMs: 1000,
}

describe('assignment de execucao', () => {
  it('leva contrato minimo suficiente e nenhum dump do projeto (P14)', () => {
    const assignment = buildExecuteAssignment(context)
    expect(assignment.kind).toBe('execute')
    expect(assignment.objective).toBe('motor com prova')
    expect(assignment.touches).toEqual(['packages/engine/'])
    expect(assignment.reads).toEqual(['docs/'])
    expect(assignment.denyPaths).toEqual(['.agentic/'])
    expect(assignment.validation).toEqual(['o gate passa'])
    expect(assignment.constraints).toEqual(['sem dependencia nova'])
  })

  it('aponta a worktree da tentativa e o limite de tempo (I11)', () => {
    const assignment = buildExecuteAssignment(context)
    expect(assignment.workspacePath).toBe('/tmp/worktrees/T04-a1')
    expect(assignment.timeoutMs).toBe(1000)
    expect(assignment.satisfiedDependencies).toEqual(['T01'])
  })
})

describe('assignment de revisao', () => {
  const gate: GateExecution = {
    id: 'gate_1',
    gateId: 'unit' as GateExecution['gateId'],
    scope: 'task',
    runId: RUN,
    startedAt: new Date(0),
    status: 'PASS',
    results: [],
  }

  it('entrega diff, resultados de gate e a politica exigida', () => {
    const assignment = buildReviewAssignment({
      ...context,
      diffRef: 'runs/x/patch.diff',
      gateExecutions: [gate],
      policy: 'cross-provider-required',
    })
    expect(assignment.kind).toBe('review')
    expect(assignment.diffRef).toBe('runs/x/patch.diff')
    expect(assignment.gateExecutions).toHaveLength(1)
    expect(assignment.policy).toBe('cross-provider-required')
  })

  it('nao carrega a narrativa do executor (P07)', () => {
    const assignment = buildReviewAssignment({
      ...context,
      diffRef: 'runs/x/patch.diff',
      gateExecutions: [],
      policy: 'fresh-session',
    })
    expect(Object.keys(assignment)).not.toContain('claims')
    expect(JSON.stringify(assignment)).not.toContain('claims')
  })
})

describe('SharedTreeIntegrator', () => {
  const attempt = {
    workspace: { kind: 'shared', path: '/tmp/repo', branch: 'main' },
    observation: { commit: 'deadbeef' },
  } as unknown as Attempt

  it('reconhece o commit medido pelo control plane', async () => {
    const result = await new SharedTreeIntegrator().integrate(attempt)
    expect(result.status).toBe('MERGED')
    expect(result.commit?.sha).toBe('deadbeef')
  })

  it('nao presume integracao sem commit observado', async () => {
    const result = await new SharedTreeIntegrator().integrate({
      ...attempt,
      observation: undefined,
    } as Attempt)
    expect(result.status).toBe('SKIPPED')
  })
})
