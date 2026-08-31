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

// ---------------------------------------------------------------- polimento operacional

/** Copia o snapshot trocando o estado de uma task — util para montar cenarios de espera. */
export function withTaskStatus(
  snapshot: RunSnapshot,
  taskId: string,
  patch: Partial<TaskSnapshotDto>,
): RunSnapshot {
  const tasks = snapshot.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task))
  return { ...snapshot, tasks }
}

/** Todo provider ocupado: `READY` que nao anda porque nao ha vaga no fornecedor. */
export function withSaturatedProviders(snapshot: RunSnapshot): RunSnapshot {
  return {
    ...snapshot,
    providers: snapshot.providers.map((provider) => ({
      ...provider,
      running: provider.capacity ?? provider.running,
    })),
  }
}

export function withRunStatus(snapshot: RunSnapshot, status: RunSnapshot['run']['status']) {
  return { ...snapshot, run: { ...snapshot.run, status } }
}

/** Bloqueio de politica: `cross-provider-required` sem segundo fornecedor apto (I10). */
export const CROSS_PROVIDER_BLOCKAGE = {
  kind: 'POLICY' as const,
  reason: 'CROSS_PROVIDER_UNAVAILABLE',
  raisedBy: 'orchestrator',
  raisedAt: '2026-01-08T12:35:00.000Z',
  needs: 'segundo fornecedor apto a revisar, ou mudanca explicita da politica de revisao',
}

export const ATTEMPTS_EXHAUSTED_BLOCKAGE = {
  kind: 'ATTEMPTS_EXHAUSTED' as const,
  reason: '3 de 3 tentativas consumidas com NO_CHANGES',
  raisedBy: 'orchestrator',
  raisedAt: '2026-01-08T12:36:00.000Z',
  needs: 'decisao humana: retry manual, unblock com nota ou skip com motivo',
}

/**
 * Providers com prontidao observavel (T203): caminho resolvido, como a prontidao foi
 * apurada e o diagnostico do ambiente. `unknown` viaja como literal.
 */
export const PROVIDERS_WITH_ENVIRONMENT: ProviderHealthDto[] = [
  {
    providerId: 'agente-a',
    installed: true,
    ready: 'unknown',
    version: '2.1.4',
    detail: 'CLI nao expoe estado de autenticacao',
    running: 2,
    capacity: 3,
    probedAt: '2026-01-08T12:40:00.000Z',
    resolvedPath: '/usr/local/bin/agente-a',
    readinessSource: 'probe nao suportada pela CLI',
  },
  {
    providerId: 'agente-b',
    installed: false,
    ready: false,
    version: 'unknown',
    detail: 'symlink apontando para instalacao removida',
    running: 0,
    capacity: 2,
    probedAt: '2026-01-08T12:40:00.000Z',
    resolvedPath: 'unknown',
    readinessSource: 'nao apurada: executavel ausente',
    diagnostic: {
      kind: 'broken-symlink',
      detail: 'link em ~/.local/bin/agente-b aponta para caminho inexistente',
      target: '/opt/agente-b/bin/agente-b',
      remediation: 'reinstale a CLI ou refaca o link',
    },
  },
]

/**
 * Evidencia do smoke com agente real (run 01M1AEP5JDG6MTMZWYGWVXBBYE): tres tentativas
 * falharam com `NO_CHANGES` e nao havia como descobrir por que — nenhum log do agente foi
 * persistido, e o gate nem chegou a rodar.
 */
export function makeNoChangesTaskDetail(): TaskDetail {
  return {
    id: 'T02',
    title: 'Modelo de dominio',
    objective: 'Implementar o modelo de dominio do exemplo.',
    phase: 'foundation',
    status: 'FAILED',
    graph: { dependencies: [], dependents: ['T04'], onCriticalPath: false },
    scope: { touches: ['packages/dominio/'], reads: [], outOfScopePaths: [] },
    execution: {
      provider: 'agente-a',
      executor: {
        profileId: 'executor',
        providerId: 'agente-a',
        sessionRef: 'sess-t02-a2',
        startedAt: '2026-01-08T12:20:00.000Z',
      },
      attempt: { number: 2, max: 2 },
      startedAt: '2026-01-08T12:20:00.000Z',
      durationMs: 61_000,
    },
    review: { findings: [] },
    isolation: {
      kind: 'git-worktree',
      worktreePath: '/home/dev/projeto/.agentic/worktrees/DA-BPM-021/T02-a2',
      branch: 'agentic/DA-BPM-021/T02',
      baseCommit: 'bbb222',
    },
    quality: { validation: ['npm test'], gate: 'foundation', commandResults: [] },
    facts: {
      filesChanged: [],
      diffStat: { files: 0, added: 0, removed: 0 },
      evidence: [],
    },
    failure: { failureCode: 'NO_CHANGES', detail: 'nenhum arquivo alterado na worktree' },
    attempts: [
      {
        id: 'att-t02-1',
        attemptNumber: 1,
        startedAt: '2026-01-08T12:12:00.000Z',
        finishedAt: '2026-01-08T12:14:00.000Z',
        durationMs: 120_000,
        result: 'FAIL',
        failure: { failureCode: 'NO_CHANGES' },
        worktreePath: '/home/dev/projeto/.agentic/worktrees/DA-BPM-021/T02-a1',
        branch: 'agentic/DA-BPM-021/T02',
      },
      {
        id: 'att-t02-2',
        attemptNumber: 2,
        startedAt: '2026-01-08T12:20:00.000Z',
        finishedAt: '2026-01-08T12:21:01.000Z',
        durationMs: 61_000,
        result: 'FAIL',
        failure: { failureCode: 'NO_CHANGES' },
        worktreePath: '/home/dev/projeto/.agentic/worktrees/DA-BPM-021/T02-a2',
        branch: 'agentic/DA-BPM-021/T02',
      },
    ],
    events: [
      {
        seq: 120,
        ts: '2026-01-08T12:19:58.000Z',
        type: 'workspace.acquired',
        actor: { kind: 'orchestrator' },
        taskId: 'T02',
        attemptId: 'att-t02-2',
        payload: { workspace: { path: '/home/dev/projeto/.agentic/worktrees/DA-BPM-021/T02-a2' } },
      },
      {
        seq: 121,
        ts: '2026-01-08T12:20:00.000Z',
        type: 'attempt.started',
        actor: { kind: 'orchestrator' },
        taskId: 'T02',
        attemptId: 'att-t02-2',
        payload: { attemptNumber: 2 },
      },
      {
        seq: 122,
        ts: '2026-01-08T12:21:01.000Z',
        type: 'task.failed',
        actor: { kind: 'orchestrator' },
        taskId: 'T02',
        attemptId: 'att-t02-2',
        payload: { failure: { code: 'NO_CHANGES' } },
      },
    ],
  }
}

/** Falha com violacao de escopo e gate que rodou — o oposto do caso `NO_CHANGES`. */
export function makeScopeViolationTaskDetail(): TaskDetail {
  const base = makeTaskDetail()
  return {
    ...base,
    status: 'FAILED',
    scope: { ...base.scope, outOfScopePaths: ['packages/dominio/regra.ts', '.agentic/state.db'] },
    failure: {
      failureCode: 'SCOPE_VIOLATION',
      detail: '2 caminhos fora de touches',
    },
    execution: { ...base.execution, attempt: { number: 3, max: 3 } },
    events: [
      ...base.events,
      {
        seq: 510,
        ts: '2026-01-08T12:48:00.000Z',
        type: 'gate.started',
        actor: { kind: 'orchestrator' },
        taskId: 'T09',
        payload: { gateId: 'frontend', scope: 'task' },
      },
      {
        seq: 511,
        ts: '2026-01-08T12:48:41.000Z',
        type: 'gate.finished',
        actor: { kind: 'orchestrator' },
        taskId: 'T09',
        payload: { gateExecutionId: 'gate-9', status: 'FAIL' },
      },
      {
        seq: 512,
        ts: '2026-01-08T12:48:42.000Z',
        type: 'policy.scope_violation',
        actor: { kind: 'orchestrator' },
        taskId: 'T09',
        payload: { outOfScopePaths: ['packages/dominio/regra.ts'], occurrence: 1 },
      },
    ],
  }
}

/** Task bloqueada por politica de revisao, com dependentes parados atras dela. */
export function makeBlockedTaskDetail(): TaskDetail {
  const base = makeTaskDetail()
  return {
    ...base,
    status: 'BLOCKED',
    blockage: CROSS_PROVIDER_BLOCKAGE,
    failure: undefined,
    events: [
      ...base.events,
      {
        seq: 520,
        ts: '2026-01-08T12:35:00.000Z',
        type: 'task.blocked',
        actor: { kind: 'orchestrator' },
        taskId: 'T09',
        payload: { blockage: CROSS_PROVIDER_BLOCKAGE },
      },
    ],
  }
}

/** Tentativa viva: worktree, agente, gate e revisao — todos medidos pelo control plane. */
export function makeLiveTaskDetail(): TaskDetail {
  const base = makeTaskDetail()
  return {
    ...base,
    events: [
      {
        seq: 480,
        ts: '2026-01-08T12:42:46.000Z',
        type: 'workspace.acquired',
        actor: { kind: 'orchestrator' },
        taskId: 'T09',
        attemptId: '01J8ZC0X0000000000ATTEMPT9',
        payload: { workspace: { path: '/home/dev/projeto/.agentic/worktrees/DA-BPM-021/T09-a2' } },
      },
      {
        seq: 481,
        ts: '2026-01-08T12:42:48.000Z',
        type: 'attempt.started',
        actor: { kind: 'orchestrator' },
        taskId: 'T09',
        attemptId: '01J8ZC0X0000000000ATTEMPT9',
        payload: { attemptNumber: 2, claims: { done: true } },
      },
      {
        seq: 482,
        ts: '2026-01-08T12:44:10.000Z',
        type: 'attempt.observed',
        actor: { kind: 'orchestrator' },
        taskId: 'T09',
        attemptId: '01J8ZC0X0000000000ATTEMPT9',
        payload: { observation: { diffRef: 'runs/01J8ZC/T09/a2/diff.patch' } },
      },
      {
        seq: 483,
        ts: '2026-01-08T12:44:30.000Z',
        type: 'gate.started',
        actor: { kind: 'orchestrator' },
        taskId: 'T09',
        payload: { gateId: 'frontend', scope: 'task' },
      },
      {
        seq: 484,
        ts: '2026-01-08T12:45:11.000Z',
        type: 'gate.finished',
        actor: { kind: 'orchestrator' },
        taskId: 'T09',
        payload: { gateExecutionId: 'gate-frontend-9', status: 'FAIL' },
      },
      {
        seq: 485,
        ts: '2026-01-08T12:45:12.000Z',
        type: 'review.requested',
        actor: { kind: 'orchestrator' },
        taskId: 'T09',
        payload: { policy: 'cross-provider-required' },
      },
    ],
  }
}

/**
 * Rajada de eventos SSE: muda o estado de varias tasks em sequencia. Serve para provar que
 * geometria e selecao nao se mexem (DASHBOARD 6, itens 27 e 28).
 */
export function makeEventBurst(startSeq = 600): EventDto[] {
  const at = (offset: number): string =>
    new Date(Date.parse('2026-01-08T12:50:00.000Z') + offset * 1000).toISOString()
  const steps: { type: EventDto['type']; taskId: string }[] = [
    { type: 'task.dispatched', taskId: 'T12' },
    { type: 'task.verifying', taskId: 'T12' },
    { type: 'task.review_requested', taskId: 'T12' },
    { type: 'task.integrating', taskId: 'T12' },
    { type: 'task.done', taskId: 'T12' },
    { type: 'task.done', taskId: 'T09' },
    { type: 'task.dispatched', taskId: 'T11' },
    { type: 'task.failed', taskId: 'T11' },
    { type: 'task.retry_scheduled', taskId: 'T11' },
    { type: 'task.blocked', taskId: 'T10' },
    { type: 'task.unblocked', taskId: 'T10' },
    { type: 'task.skipped', taskId: 'T13' },
  ]
  return steps.map((step, index) => ({
    seq: startSeq + index,
    ts: at(index),
    type: step.type,
    actor: { kind: 'orchestrator' },
    taskId: step.taskId,
    payload:
      step.type === 'task.blocked'
        ? { blockage: CROSS_PROVIDER_BLOCKAGE }
        : step.type === 'task.retry_scheduled'
          ? { attemptCount: 2, backoffMs: 15_000 }
          : {},
  }))
}

/**
 * Snapshot sintetico com N nos (15–30) para provar estabilidade de geometria em escala.
 * A estrutura vem toda de `graph`; o estado das tasks entra por fora.
 */
export function makeWideSnapshot(size = 30): RunSnapshot {
  const base = makeSnapshot()
  const ids = Array.from({ length: size }, (_, index) => `W${String(index + 1).padStart(2, '0')}`)
  const phases = ['foundation', 'backend', 'frontend', 'quality']
  const nodes: GraphNodeDto[] = ids.map((id, index) => ({
    id,
    title: `Task sintetica ${id}`,
    phase: phases[index % phases.length] ?? 'foundation',
    dependencies: index < 4 ? [] : [ids[index - 4] as string],
    touches: [`pacote/${id}/`],
    risk: 'low',
    estimate: 1,
  }))
  const edges = nodes.flatMap((node) => node.dependencies.map((from) => ({ from, to: node.id })))
  const tasks: TaskSnapshotDto[] = ids.map((id, index) => ({
    id,
    status: index < 4 ? 'DONE' : index < 8 ? 'RUNNING' : 'PENDING',
    attemptCount: index < 8 ? 1 : 0,
    unblockedBy: [],
  }))
  const counters = { ...base.counters, DONE: 4, RUNNING: 4, PENDING: size - 8, READY: 0, RETRY: 0, BLOCKED: 0 }
  return {
    ...base,
    graph: {
      nodes,
      edges,
      waves: [ids.slice(0, 4), ids.slice(4)],
      criticalPath: [],
      slack: Object.fromEntries(ids.map((id) => [id, 0])),
    },
    tasks,
    counters,
  }
}

// ---------------------------------------------------------- explicabilidade operacional

/** Bloqueio de politica que **nao** e revisao cruzada: `denyPaths` do run barrou a task. */
export const POLICY_BLOCKAGE = {
  kind: 'POLICY' as const,
  reason: 'DENY_PATH: a task declarou touches em .agentic/',
  raisedBy: 'orchestrator',
  raisedAt: '2026-01-08T12:37:00.000Z',
  needs: 'corrigir os touches da task no YAML da missao',
}

function logPersisted(
  seq: number,
  taskId: string,
  attemptId: string,
  payload: Record<string, unknown>,
): EventDto {
  return {
    seq,
    ts: '2026-01-08T12:21:02.000Z',
    type: 'attempt.log_persisted',
    actor: { kind: 'orchestrator' },
    taskId,
    attemptId,
    payload,
  }
}

/**
 * DA-DOGFOOD-001, T02: o agente investigou, concluiu que a premissa da task era falsa e
 * **nao alterou nada**. O log da tentativa existe e explica — o desfecho continua sendo
 * `NO_CHANGES`, medido pelo control plane.
 */
export function makeNoChangesWithLogTaskDetail(): TaskDetail {
  const base = makeNoChangesTaskDetail()
  return {
    ...base,
    events: [
      ...base.events,
      logPersisted(123, 'T02', 'att-t02-2', {
        role: 'execute',
        path: '.agentic/runs/01J8ZC/attempts/T02-a2/agent.log.jsonl',
        bytes: 18_442,
        truncated: false,
      }),
    ],
  }
}

/** Log do agente cortado no teto de captura, com saida de comando de gate tambem truncada. */
export function makeTruncatedLogTaskDetail(): TaskDetail {
  const base = makeTaskDetail()
  return {
    ...base,
    quality: {
      ...base.quality,
      commandResults: base.quality.commandResults.map((result) => ({ ...result, truncated: true })),
    },
    events: [
      ...base.events,
      logPersisted(530, 'T09', '01J8ZC0X0000000000ATTEMPT9', {
        role: 'execute',
        path: '.agentic/runs/01J8ZC/attempts/T09-a2/agent.log.jsonl',
        bytes: 4_194_304,
        truncated: true,
      }),
      logPersisted(531, 'T09', '01J8ZC0X0000000000ATTEMPT9', {
        role: 'review',
        path: '.agentic/runs/01J8ZC/attempts/T09-a2/review.log.jsonl',
        bytes: 2_048,
        truncated: false,
      }),
    ],
  }
}

/** Rajada de logs persistidos: prova que a lista da tela tem teto e nao cresce sem fim. */
export function makeManyLogsTaskDetail(count = 60): TaskDetail {
  const base = makeTaskDetail()
  const events = Array.from({ length: count }, (_, index) =>
    logPersisted(600 + index, 'T09', `att-${index}`, {
      role: 'execute',
      path: `.agentic/runs/01J8ZC/attempts/T09-a${index}/agent.log.jsonl`,
      bytes: 1_024 * (index + 1),
      truncated: false,
    }),
  )
  return { ...base, events: [...base.events, ...events] }
}
