import type {
  CompileReportDto,
  EventDto,
  GraphNodeDto,
  ProviderHealthDto,
  RunSnapshot,
  TaskDetail,
  TaskSnapshotDto,
} from '@agentic/schemas'

/**
 * Fixture do contrato: 17 tasks em 7 fases, como o cenario de DASHBOARD.md. O dashboard e
 * desenvolvido contra ela — o servidor (T13) nao e dependencia desta tela.
 */

interface Seed {
  readonly id: string
  readonly title: string
  readonly phase: string
  readonly dependencies: readonly string[]
  readonly touches: readonly string[]
  readonly risk: 'low' | 'medium' | 'high'
  readonly estimate: number
}

const SEEDS: readonly Seed[] = [
  {
    id: 'T01',
    title: 'Esqueleto do workspace',
    phase: 'foundation',
    dependencies: [],
    touches: ['packages/base/'],
    risk: 'low',
    estimate: 2,
  },
  {
    id: 'T02',
    title: 'Modelo de dominio',
    phase: 'foundation',
    dependencies: [],
    touches: ['packages/dominio/'],
    risk: 'high',
    estimate: 6,
  },
  {
    id: 'T03',
    title: 'Contratos de leitura',
    phase: 'contracts',
    dependencies: ['T01'],
    touches: ['packages/contratos/leitura/'],
    risk: 'medium',
    estimate: 4,
  },
  {
    id: 'T04',
    title: 'Contratos de comando',
    phase: 'contracts',
    dependencies: ['T01', 'T02'],
    touches: ['packages/contratos/comandos/'],
    risk: 'medium',
    estimate: 3,
  },
  {
    id: 'T05',
    title: 'Endpoint de gravacao',
    phase: 'backend',
    dependencies: ['T03'],
    touches: ['servidor/gravacao/'],
    risk: 'high',
    estimate: 5,
  },
  {
    id: 'T06',
    title: 'Endpoint de consulta',
    phase: 'backend',
    dependencies: ['T03', 'T04'],
    touches: ['servidor/consulta/'],
    risk: 'medium',
    estimate: 4,
  },
  {
    id: 'T07',
    title: 'Fila de trabalho',
    phase: 'backend',
    dependencies: ['T04'],
    touches: ['servidor/fila/'],
    risk: 'medium',
    estimate: 3,
  },
  {
    id: 'T08',
    title: 'Componentes base',
    phase: 'frontend',
    dependencies: ['T03'],
    touches: ['ui/base/'],
    risk: 'low',
    estimate: 4,
  },
  {
    id: 'T09',
    title: 'Painel de propriedades',
    phase: 'frontend',
    dependencies: ['T05'],
    touches: ['ui/propriedades/'],
    risk: 'high',
    estimate: 7,
  },
  {
    id: 'T10',
    title: 'Listagem paginada',
    phase: 'frontend',
    dependencies: ['T06'],
    touches: ['ui/listagem/'],
    risk: 'medium',
    estimate: 4,
  },
  {
    id: 'T11',
    title: 'Testes de integracao',
    phase: 'quality',
    dependencies: ['T05', 'T09'],
    touches: ['testes/integracao/'],
    risk: 'high',
    estimate: 9,
  },
  {
    id: 'T12',
    title: 'Testes de carga',
    phase: 'quality',
    dependencies: ['T07'],
    touches: ['testes/carga/'],
    risk: 'medium',
    estimate: 3,
  },
  {
    id: 'T13',
    title: 'Testes de acessibilidade',
    phase: 'quality',
    dependencies: ['T10'],
    touches: ['testes/a11y/'],
    risk: 'low',
    estimate: 4,
  },
  {
    id: 'T14',
    title: 'Guia do componente',
    phase: 'docs',
    dependencies: ['T08'],
    touches: ['docs/componentes/'],
    risk: 'low',
    estimate: 2,
  },
  {
    id: 'T15',
    title: 'Manual de operacao',
    phase: 'docs',
    dependencies: ['T11'],
    touches: ['docs/operacao/'],
    risk: 'low',
    estimate: 5,
  },
  {
    id: 'T16',
    title: 'Empacotamento',
    phase: 'release',
    dependencies: ['T12', 'T13', 'T15'],
    touches: ['release/pacote/'],
    risk: 'medium',
    estimate: 5,
  },
  {
    id: 'T17',
    title: 'Notas da versao',
    phase: 'release',
    dependencies: ['T14', 'T16'],
    touches: ['release/notas/'],
    risk: 'low',
    estimate: 3,
  },
]

const NODES: GraphNodeDto[] = SEEDS.map((seed) => ({
  id: seed.id,
  title: seed.title,
  phase: seed.phase,
  dependencies: [...seed.dependencies],
  touches: [...seed.touches],
  risk: seed.risk,
  estimate: seed.estimate,
}))

const EDGES = SEEDS.flatMap((seed) => seed.dependencies.map((from) => ({ from, to: seed.id })))

/** Ondas (earliest start) e caminho critico vem do compilador — a UI apenas os le. */
const WAVES: string[][] = [
  ['T01', 'T02'],
  ['T03', 'T04'],
  ['T05', 'T06', 'T07', 'T08'],
  ['T09', 'T10', 'T12', 'T14'],
  ['T11', 'T13'],
  ['T15'],
  ['T16'],
  ['T17'],
]

const CRITICAL_PATH = ['T01', 'T03', 'T05', 'T09', 'T11', 'T15', 'T16', 'T17']

const SLACK: Record<string, number> = {
  T01: 0,
  T02: 11,
  T03: 0,
  T04: 11,
  T05: 0,
  T06: 11,
  T07: 17,
  T08: 25,
  T09: 0,
  T10: 11,
  T11: 0,
  T12: 17,
  T13: 11,
  T14: 25,
  T15: 0,
  T16: 0,
  T17: 0,
}

const STATUSES: Record<string, TaskSnapshotDto['status']> = {
  T01: 'DONE',
  T02: 'DONE',
  T03: 'DONE',
  T04: 'DONE',
  T05: 'DONE',
  T06: 'DONE',
  T07: 'DONE',
  T08: 'DONE',
  T09: 'RUNNING',
  T10: 'RETRY',
  T11: 'PENDING',
  T12: 'READY',
  T13: 'PENDING',
  T14: 'BLOCKED',
  T15: 'PENDING',
  T16: 'PENDING',
  T17: 'PENDING',
}

const TASKS: TaskSnapshotDto[] = SEEDS.map((seed) => {
  const status = STATUSES[seed.id] ?? 'PENDING'
  const base: TaskSnapshotDto = {
    id: seed.id,
    status,
    attemptCount: status === 'PENDING' ? 0 : 1,
    unblockedBy: [...seed.dependencies],
  }
  if (status === 'DONE') {
    return {
      ...base,
      readyAt: '2026-01-08T12:10:00.000Z',
      startedAt: '2026-01-08T12:12:00.000Z',
      finishedAt: '2026-01-08T12:26:00.000Z',
      durationMs: 840_000,
    }
  }
  if (status === 'RUNNING') {
    return {
      ...base,
      attemptCount: 2,
      currentAttempt: '01J8ZC0X0000000000ATTEMPT9',
      readyAt: '2026-01-08T12:26:00.000Z',
      startedAt: '2026-01-08T12:42:48.000Z',
    }
  }
  if (status === 'RETRY') {
    return { ...base, attemptCount: 1, readyAt: '2026-01-08T12:30:00.000Z' }
  }
  if (status === 'READY') {
    return { ...base, attemptCount: 0, readyAt: '2026-01-08T12:31:00.000Z' }
  }
  if (status === 'BLOCKED') {
    return {
      ...base,
      blockage: {
        kind: 'ARCHITECTURAL',
        reason: 'contrato do componente ainda nao decidido',
        raisedBy: 'executor',
        raisedAt: '2026-01-08T12:33:00.000Z',
        needs: 'decisao humana sobre o formato do slot',
      },
    }
  }
  return base
})

export const PROVIDERS: ProviderHealthDto[] = [
  {
    providerId: 'agente-a',
    installed: true,
    ready: 'unknown',
    version: '2.1.4',
    detail: 'CLI nao expoe estado de autenticacao',
    running: 2,
    capacity: 3,
    probedAt: '2026-01-08T12:40:00.000Z',
  },
  {
    providerId: 'agente-b',
    installed: true,
    ready: 'unknown',
    version: '0.9.2',
    detail: 'CLI nao expoe estado de autenticacao',
    running: 1,
    capacity: 2,
    probedAt: '2026-01-08T12:40:00.000Z',
  },
  {
    providerId: 'mock',
    installed: true,
    ready: true,
    version: '0.0.0',
    detail: 'provider de teste',
    running: 0,
    capacity: 8,
    probedAt: '2026-01-08T12:40:00.000Z',
  },
]

export const RUN_ID = '01J8ZC0X0000000000000000AA'
export const MISSION_ID = 'DA-BPM-021'

export function makeSnapshot(): RunSnapshot {
  return {
    run: {
      id: RUN_ID,
      missionId: MISSION_ID,
      status: 'RUNNING',
      timestamps: {
        createdAt: '2026-01-08T12:05:00.000Z',
        approvedAt: '2026-01-08T12:08:00.000Z',
        startedAt: '2026-01-08T12:10:00.000Z',
      },
      policies: {
        maxParallelTasks: 3,
        maxExecutors: 3,
        maxReviewers: 2,
        defaultMaxAttempts: 3,
        attemptTimeoutMs: 1_800_000,
        retryBackoffMs: 15_000,
        workspaceMode: 'git-worktree',
        enforceTouches: true,
        denyPaths: ['.agentic/', 'segredos/'],
      },
      missionGate: 'mission',
      integrationBranch: 'agentic/DA-BPM-021',
    },
    graph: {
      nodes: NODES.map((node) => ({ ...node })),
      edges: EDGES.map((edge) => ({ ...edge })),
      waves: WAVES.map((wave) => [...wave]),
      criticalPath: [...CRITICAL_PATH],
      slack: { ...SLACK },
    },
    tasks: TASKS.map((task) => ({ ...task })),
    counters: {
      PENDING: 5,
      READY: 1,
      RUNNING: 1,
      VERIFYING: 0,
      REVIEW: 0,
      INTEGRATING: 0,
      DONE: 8,
      FAILED: 0,
      RETRY: 1,
      BLOCKED: 1,
      SKIPPED: 0,
      CANCELLED: 0,
    },
    providers: PROVIDERS.map((provider) => ({ ...provider })),
    metrics: {
      wallTimeMs: 2_040_000,
      attempts: 21,
      retries: 4,
      reviewFailures: 3,
      parallelismRatio: 2.4,
    },
  }
}

/** Evento que conclui `T09` — o dependente `T11` precisa acender `READY` sem reload. */
export function taskDoneEvent(taskId = 'T09', seq = 501): EventDto {
  return {
    seq,
    ts: '2026-01-08T12:47:31.000Z',
    type: 'task.done',
    actor: { kind: 'orchestrator' },
    taskId,
    payload: { durationMs: 300_000 },
  }
}

export function makeEvents(): EventDto[] {
  return [
    {
      seq: 498,
      ts: '2026-01-08T12:46:41.000Z',
      type: 'review.finished',
      actor: { kind: 'agent', id: 'revisor' },
      taskId: 'T10',
      payload: { verdict: 'FAIL', findings: 1 },
    },
    {
      seq: 499,
      ts: '2026-01-08T12:46:57.000Z',
      type: 'task.retry_scheduled',
      actor: { kind: 'orchestrator' },
      taskId: 'T10',
      payload: { reason: 'REVIEW_FAILED', backoffMs: 15_000 },
    },
    {
      seq: 500,
      ts: '2026-01-08T12:46:58.000Z',
      type: 'attempt.started',
      actor: { kind: 'orchestrator' },
      taskId: 'T09',
      attemptId: '01J8ZC0X0000000000ATTEMPT9',
      payload: { attemptNumber: 2, executor: 'frontend-executor' },
    },
  ]
}

export function makeTaskDetail(): TaskDetail {
  return {
    id: 'T09',
    title: 'Painel de propriedades',
    description: 'Reescreve o painel lateral com o novo contrato de propriedades.',
    objective: 'Painel de propriedades usando os contratos de leitura de T03.',
    phase: 'frontend',
    status: 'RUNNING',
    graph: {
      dependencies: [{ id: 'T05', status: 'DONE' }],
      dependents: ['T11'],
      onCriticalPath: true,
    },
    scope: {
      touches: ['ui/propriedades/'],
      reads: ['packages/contratos/leitura/'],
      outOfScopePaths: [],
    },
    execution: {
      provider: 'agente-a',
      executor: {
        profileId: 'frontend-executor',
        providerId: 'agente-a',
        model: 'modelo-grande',
        sessionRef: 'sess-executor-9',
        startedAt: '2026-01-08T12:42:48.000Z',
      },
      attempt: { number: 2, max: 3 },
      startedAt: '2026-01-08T12:42:48.000Z',
      durationMs: 252_000,
    },
    review: {
      reviewer: {
        profileId: 'revisor-independente',
        providerId: 'agente-b',
        model: 'modelo-medio',
        sessionRef: 'sess-revisor-9',
        startedAt: '2026-01-08T12:40:00.000Z',
      },
      reviewerProvider: 'agente-b',
      policy: 'cross-provider-required',
      policyOutcome: 'satisfied',
      verdict: 'FAIL',
      findings: [
        {
          severity: 'error',
          path: 'ui/propriedades/painel.tsx',
          line: 48,
          message: '403 ausente para usuario sem permissao',
        },
      ],
    },
    isolation: {
      kind: 'git-worktree',
      worktreePath: '/home/dev/projeto/.agentic/worktrees/DA-BPM-021/T09-a2',
      branch: 'agentic/DA-BPM-021/T09',
      baseCommit: 'a1b2c3d4e5f6',
      commit: 'f6e5d4c3b2a1',
    },
    quality: {
      validation: ['npm test -w ui', 'npm run lint'],
      gate: 'frontend',
      gateStatus: 'FAIL',
      commandResults: [
        {
          command: 'npm test -w ui',
          cwd: '/home/dev/projeto/.agentic/worktrees/DA-BPM-021/T09-a2',
          exitCode: 1,
          durationMs: 41_000,
          stdoutRef: 'runs/01J8ZC/T09/a2/test.log',
          truncated: false,
        },
      ],
    },
    facts: {
      filesChanged: [
        { path: 'ui/propriedades/painel.tsx', change: 'M', added: 84, removed: 12 },
        { path: 'ui/propriedades/painel.test.tsx', change: 'A', added: 120, removed: 0 },
      ],
      diffStat: { files: 2, added: 204, removed: 12 },
      evidence: [
        {
          kind: 'gate',
          sourceId: 'gate-frontend-9',
          artifactPath: 'runs/01J8ZC/T09/a2/gate.json',
          digest: 'sha256:abc123',
        },
      ],
    },
    failure: { failureCode: 'REVIEW_FAILED', detail: '1 finding de severidade error' },
    attempts: [
      {
        id: 'att-1',
        attemptNumber: 1,
        startedAt: '2026-01-08T12:26:00.000Z',
        finishedAt: '2026-01-08T12:40:00.000Z',
        durationMs: 840_000,
        result: 'FAIL',
        failure: { failureCode: 'REVIEW_FAILED' },
        gateStatus: 'FAIL',
        reviewVerdict: 'FAIL',
        worktreePath: '/home/dev/projeto/.agentic/worktrees/DA-BPM-021/T09-a1',
        branch: 'agentic/DA-BPM-021/T09',
        commit: 'aaa111',
      },
      {
        id: 'att-2',
        attemptNumber: 2,
        startedAt: '2026-01-08T12:42:48.000Z',
        worktreePath: '/home/dev/projeto/.agentic/worktrees/DA-BPM-021/T09-a2',
        branch: 'agentic/DA-BPM-021/T09',
      },
    ],
    events: makeEvents().filter((event) => event.taskId === 'T09'),
  }
}

const STATS = {
  tasks: 17,
  phases: 7,
  edges: EDGES.length,
  errors: 0,
  warnings: 2,
  infos: 0,
  criticalPathLength: CRITICAL_PATH.length,
  waves: WAVES.length,
  maxParallelism: 4,
}

export function makeCompileReport(
  kind: 'clean' | 'warning' | 'error' = 'warning',
): CompileReportDto {
  if (kind === 'clean') {
    return {
      missionId: MISSION_ID,
      specHash: 'sha256:limpo',
      ok: true,
      diagnostics: [],
      stats: { ...STATS, warnings: 0 },
    }
  }
  if (kind === 'error') {
    return {
      missionId: MISSION_ID,
      specHash: 'sha256:erro',
      ok: false,
      diagnostics: [
        {
          code: 'DA1004',
          severity: 'ERROR',
          message: 'ciclo de dependencia entre T05 e T09',
          targets: ['T05', 'T09'],
          hint: 'quebre o ciclo removendo uma das dependencias',
        },
        {
          code: 'DA1008',
          severity: 'ERROR',
          message: 'touches de T12 aponta para fora do repositorio',
          targets: ['T12'],
        },
      ],
      stats: { ...STATS, errors: 2 },
    }
  }
  return {
    missionId: MISSION_ID,
    specHash: 'sha256:aviso',
    ok: true,
    diagnostics: [
      {
        code: 'DA2001',
        severity: 'WARNING',
        message: 'T07 e T09 escrevem em ui/propriedades/ sem dependencia entre si',
        targets: ['T07', 'T09'],
        hint: 'declare a dependencia ou separe os touches',
      },
      {
        code: 'DA2007',
        severity: 'WARNING',
        message: 'T12 tem risk high com requireReview false',
        targets: ['T12'],
      },
    ],
    stats: STATS,
  }
}
