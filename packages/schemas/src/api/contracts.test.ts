import { describe, expect, it } from 'vitest'
import {
  ApproveMissionCommandSchema,
  SkipTaskCommandSchema,
  StartRunCommandSchema,
  TaskCommandSchema,
  UnblockTaskCommandSchema,
} from './commands.js'
import { type CompileReportDto, CompileReportDtoSchema } from './compile-report.js'
import { type EventDto, EventDtoSchema } from './events.js'
import { type ProviderHealthDto, ProviderHealthDtoSchema } from './provider-health.js'
import { type RunSnapshot, RunSnapshotSchema, TaskCountersSchema } from './run-snapshot.js'
import { type TaskDetail, TaskDetailSchema } from './task-detail.js'

const health: ProviderHealthDto = {
  providerId: 'agente-a',
  installed: true,
  ready: 'unknown',
  version: '1.2.3',
  detail: 'CLI nao expoe estado de autenticacao',
  running: 2,
  capacity: 3,
}

const snapshot: RunSnapshot = {
  run: {
    id: '01J8ZC0X0000000000000000AA',
    missionId: 'DA-TEST-001',
    status: 'RUNNING',
    timestamps: { createdAt: '2026-01-01T10:00:00.000Z', startedAt: '2026-01-01T10:05:00.000Z' },
    policies: {
      maxParallelTasks: 3,
      maxExecutors: 3,
      maxReviewers: 2,
      defaultMaxAttempts: 3,
      attemptTimeoutMs: 1_800_000,
      retryBackoffMs: 15_000,
      workspaceMode: 'git-worktree',
      enforceTouches: true,
      denyPaths: ['.agentic/', '*.pem'],
    },
  },
  graph: {
    nodes: [
      {
        id: 'T01',
        title: 'Primeira',
        phase: 'core',
        dependencies: [],
        touches: ['packages/um/'],
        risk: 'low',
        estimate: 2,
      },
      {
        id: 'T02',
        title: 'Segunda',
        phase: 'core',
        dependencies: ['T01'],
        touches: ['packages/dois/'],
        risk: 'high',
        estimate: 5,
      },
    ],
    edges: [{ from: 'T01', to: 'T02' }],
    waves: [['T01'], ['T02']],
    criticalPath: ['T01', 'T02'],
    slack: { T01: 0, T02: 0 },
  },
  tasks: [
    {
      id: 'T01',
      status: 'DONE',
      attemptCount: 1,
      unblockedBy: [],
      readyAt: '2026-01-01T10:05:00.000Z',
      startedAt: '2026-01-01T10:05:01.000Z',
      finishedAt: '2026-01-01T10:09:13.000Z',
      durationMs: 252_000,
    },
    { id: 'T02', status: 'RUNNING', attemptCount: 2, currentAttempt: 'a2', unblockedBy: ['T01'] },
  ],
  counters: TaskCountersSchema.parse({ DONE: 1, RUNNING: 1 }),
  providers: [health],
  metrics: {
    wallTimeMs: 2_040_000,
    attempts: 21,
    retries: 4,
    reviewFailures: 3,
    parallelismRatio: 2.4,
  },
}

const event: EventDto = {
  seq: 42,
  ts: '2026-01-01T10:05:01.000Z',
  type: 'task.dispatched',
  actor: { kind: 'orchestrator' },
  taskId: 'T02',
  attemptId: 'a2',
  payload: { executor: 'perfil-executor' },
}

const detail: TaskDetail = {
  id: 'T02',
  title: 'Segunda',
  objective: 'Fazer a coisa certa',
  phase: 'core',
  status: 'RUNNING',
  graph: {
    dependencies: [{ id: 'T01', status: 'DONE' }],
    dependents: [],
    onCriticalPath: true,
  },
  scope: { touches: ['packages/dois/'], reads: ['packages/um/'], outOfScopePaths: [] },
  execution: {
    provider: 'agente-a',
    executor: {
      profileId: 'executor',
      providerId: 'agente-a',
      sessionRef: 'sessao-1',
      startedAt: '2026-01-01T10:05:01.000Z',
    },
    attempt: { number: 2, max: 3 },
    startedAt: '2026-01-01T10:05:01.000Z',
    durationMs: 252_000,
  },
  review: {
    reviewer: {
      profileId: 'revisor',
      providerId: 'agente-b',
      sessionRef: 'sessao-2',
      startedAt: '2026-01-01T10:09:00.000Z',
    },
    reviewerProvider: 'agente-b',
    policy: 'cross-provider-required',
    policyOutcome: 'satisfied',
    verdict: 'FAIL',
    findings: [{ severity: 'error', message: '403 ausente para usuario sem permissao' }],
  },
  isolation: {
    kind: 'git-worktree',
    worktreePath: '.agentic/worktrees/run/T02-a2',
    branch: 'task/T02',
    baseCommit: 'abc1234',
    commit: 'def5678',
  },
  quality: {
    validation: ['Usuario sem permissao recebe 403'],
    gate: 'unit',
    gateStatus: 'FAIL',
    commandResults: [
      {
        command: 'npm run test',
        cwd: '.agentic/worktrees/run/T02-a2',
        exitCode: 1,
        durationMs: 41_000,
        truncated: false,
      },
    ],
  },
  facts: {
    filesChanged: [{ path: 'packages/dois/index.ts', change: 'M', added: 12, removed: 3 }],
    diffStat: { files: 1, added: 12, removed: 3 },
    evidence: [{ kind: 'scope', sourceId: 'obs-1', digest: 'sha256:abc' }],
  },
  failure: { failureCode: 'REVIEW_FAILED', detail: 'findings abertos' },
  attempts: [
    {
      id: 'a1',
      attemptNumber: 1,
      startedAt: '2026-01-01T10:00:00.000Z',
      finishedAt: '2026-01-01T10:04:00.000Z',
      durationMs: 240_000,
      result: 'FAIL',
      failure: { failureCode: 'REVIEW_FAILED' },
      reviewVerdict: 'FAIL',
    },
  ],
  events: [event],
}

const report: CompileReportDto = {
  missionId: 'DA-TEST-001',
  ok: true,
  diagnostics: [
    {
      code: 'DA2001',
      severity: 'WARNING',
      message: 'T07 e T09 escrevem em apps/web/src/contracts/ sem dependencia',
      targets: ['T07', 'T09'],
      hint: 'declare dependencia ou separe os escopos',
    },
  ],
  stats: {
    tasks: 17,
    phases: 7,
    edges: 21,
    errors: 0,
    warnings: 1,
    infos: 0,
    criticalPathLength: 5,
    waves: 6,
    maxParallelism: 4,
  },
}

describe('RunSnapshot', () => {
  it('aceita um snapshot completo', () => {
    expect(RunSnapshotSchema.safeParse(snapshot).success).toBe(true)
  })

  it('recusa estado de task desconhecido', () => {
    const invalid = { ...snapshot, tasks: [{ ...snapshot.tasks[0], status: 'THINKING' }] }
    expect(RunSnapshotSchema.safeParse(invalid).success).toBe(false)
  })

  it('recusa timestamp que nao e ISO-8601', () => {
    const invalid = {
      ...snapshot,
      run: { ...snapshot.run, timestamps: { createdAt: '01/01/2026' } },
    }
    expect(RunSnapshotSchema.safeParse(invalid).success).toBe(false)
  })

  it('conta os doze estados, zerando os ausentes', () => {
    expect(snapshot.counters.PENDING).toBe(0)
    expect(snapshot.counters.DONE).toBe(1)
    expect(Object.keys(snapshot.counters)).toHaveLength(12)
  })

  it('recusa campo desconhecido no snapshot', () => {
    expect(RunSnapshotSchema.safeParse({ ...snapshot, extra: 1 }).success).toBe(false)
  })
})

describe('TaskDetail', () => {
  it('aceita o detalhe com todos os grupos exigidos pelo dashboard', () => {
    const parsed = TaskDetailSchema.safeParse(detail)
    expect(parsed.success).toBe(true)
  })

  it('exige o grupo de isolamento, ainda que vazio', () => {
    const { isolation: _isolation, ...semIsolamento } = detail
    expect(TaskDetailSchema.safeParse(semIsolamento).success).toBe(false)
  })

  it('preenche findings ausentes com lista vazia', () => {
    const parsed = TaskDetailSchema.parse({ ...detail, review: {} })
    expect(parsed.review.findings).toEqual([])
  })

  it('recusa failureCode fora do catalogo fechado', () => {
    const invalid = { ...detail, failure: { failureCode: 'DEU_RUIM' } }
    expect(TaskDetailSchema.safeParse(invalid).success).toBe(false)
  })
})

describe('EventDto', () => {
  it('aceita evento com payload opaco', () => {
    expect(EventDtoSchema.safeParse(event).success).toBe(true)
  })

  it('recusa tipo de evento fora do catalogo', () => {
    expect(EventDtoSchema.safeParse({ ...event, type: 'task.pensou' }).success).toBe(false)
  })

  it('recusa ator sem kind', () => {
    expect(EventDtoSchema.safeParse({ ...event, actor: { id: 'alguem' } }).success).toBe(false)
  })
})

describe('ProviderHealthDto', () => {
  it('aceita unknown em installed e ready', () => {
    const parsed = ProviderHealthDtoSchema.parse({ ...health, installed: 'unknown' })
    expect(parsed.installed).toBe('unknown')
    expect(parsed.ready).toBe('unknown')
  })

  it('aceita capacity nula', () => {
    expect(ProviderHealthDtoSchema.safeParse({ ...health, capacity: null }).success).toBe(true)
  })

  it('recusa terceiro estado que nao seja unknown', () => {
    expect(ProviderHealthDtoSchema.safeParse({ ...health, ready: 'talvez' }).success).toBe(false)
  })
})

describe('CompileReportDto', () => {
  it('aceita relatorio com diagnostico', () => {
    expect(CompileReportDtoSchema.safeParse(report).success).toBe(true)
  })

  it('recusa codigo fora do padrao DAnnnn', () => {
    const invalid = {
      ...report,
      diagnostics: [{ ...report.diagnostics[0], code: 'WARN-1' }],
    }
    expect(CompileReportDtoSchema.safeParse(invalid).success).toBe(false)
  })

  it('recusa severidade desconhecida', () => {
    const invalid = {
      ...report,
      diagnostics: [{ ...report.diagnostics[0], severity: 'FATAL' }],
    }
    expect(CompileReportDtoSchema.safeParse(invalid).success).toBe(false)
  })
})

describe('comandos', () => {
  it('aprovacao exige actor', () => {
    expect(ApproveMissionCommandSchema.safeParse({ actor: 'ana', note: 'ok' }).success).toBe(true)
    expect(ApproveMissionCommandSchema.safeParse({ note: 'ok' }).success).toBe(false)
  })

  it('START MISSION exige exatamente um entre missionPath e missionId', () => {
    const base = { acceptWarnings: false, actor: 'ana' }
    expect(StartRunCommandSchema.safeParse({ ...base, missionId: 'DA-TEST-001' }).success).toBe(
      true,
    )
    expect(StartRunCommandSchema.safeParse({ ...base, missionPath: 'a.yaml' }).success).toBe(true)
    expect(StartRunCommandSchema.safeParse(base).success).toBe(false)
    expect(
      StartRunCommandSchema.safeParse({ ...base, missionPath: 'a.yaml', missionId: 'DA-TEST-001' })
        .success,
    ).toBe(false)
  })

  it('START MISSION exige acceptWarnings explicito', () => {
    expect(StartRunCommandSchema.safeParse({ missionPath: 'a.yaml', actor: 'ana' }).success).toBe(
      false,
    )
  })

  it('comando de task exige taskId valido', () => {
    expect(TaskCommandSchema.safeParse({ taskId: 'T04' }).success).toBe(true)
    expect(TaskCommandSchema.safeParse({ taskId: 'tarefa-4' }).success).toBe(false)
  })

  it('unblock exige nota e skip exige motivo', () => {
    expect(UnblockTaskCommandSchema.safeParse({ taskId: 'T04' }).success).toBe(false)
    expect(UnblockTaskCommandSchema.safeParse({ taskId: 'T04', note: 'resolvido' }).success).toBe(
      true,
    )
    expect(SkipTaskCommandSchema.safeParse({ taskId: 'T04' }).success).toBe(false)
    expect(SkipTaskCommandSchema.safeParse({ taskId: 'T04', reason: 'fora do MVP' }).success).toBe(
      true,
    )
  })
})
