import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider, ProviderHealth, ProviderId, ProviderRegistry } from '@agentic/domain'
import { type ControlPlane, createControlPlane } from '@agentic/orchestrator'
import type { RunSnapshot, TaskDetail } from '@agentic/schemas'
import type { CommandDeps, GitProbe } from '../deps.js'
import type { ControlPlaneLink, LinkRequest } from '../link.js'
import type { ExitCode } from '../result.js'

export const RUN_ID = '01J0000000000000000000000A'

export interface Captured {
  readonly deps: CommandDeps
  stdout(): string
  stderr(): string
  exits(): ExitCode[]
  json(): unknown
}

export interface DepsOverrides extends Partial<CommandDeps> {
  readonly cwd?: string
}

const OK_GIT: GitProbe = {
  installed: true,
  version: 'git version 2.43.0',
  repository: true,
  detail: 'repositorio git valido',
}

/** Deps com toda saida capturada: o handler nunca toca em `process` durante o teste. */
export function captureDeps(overrides: DepsOverrides = {}): Captured {
  const out: string[] = []
  const err: string[] = []
  const codes: ExitCode[] = []
  const deps: CommandDeps = {
    cwd: overrides.cwd ?? process.cwd(),
    stdout: (text) => {
      out.push(text)
    },
    stderr: (text) => {
      err.push(text)
    },
    exit: (code) => {
      codes.push(code)
    },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    env: { USER: 'teste' },
    nodeVersion: '22.11.0',
    controlPlane: (config) => createControlPlane(config),
    registry: () => fakeRegistry([]),
    connect: () => Promise.resolve(undefined),
    probeGit: () => Promise.resolve(OK_GIT),
    waitForShutdown: () => Promise.resolve(),
    ...overrides,
  }
  return {
    deps,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    exits: () => codes,
    json: () => JSON.parse(out.join('')) as unknown,
  }
}

export function health(
  partial: Omit<Partial<ProviderHealth>, 'providerId'> & { readonly providerId: string },
): ProviderHealth {
  return {
    installed: 'unknown',
    ready: 'unknown',
    version: 'unknown',
    detail: 'sonda nao conclusiva',
    running: 0,
    capacity: 1,
    probedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...partial,
    providerId: partial.providerId as ProviderId,
  }
}

/** Registry de mentira: nenhuma CLI real e sondada em teste (P17, nenhuma quota). */
export function fakeRegistry(entries: readonly ProviderHealth[]): ProviderRegistry {
  return {
    get: (id: ProviderId): AgentProvider => {
      throw new Error(`provider ${id} nao disponivel no teste`)
    },
    list: () => entries.map((entry) => entry.providerId),
    health: () => Promise.resolve([...entries]),
    capacity: () => ({
      global: { maxParallelTasks: 1, active: 0 },
      executor: { max: 1, active: 0 },
      reviewer: { max: 1, active: 0 },
      byProvider: {},
    }),
  }
}

export interface RecordedLink {
  readonly link: ControlPlaneLink
  readonly requests: LinkRequest[]
}

export function recordingLink(endpoint = 'http://127.0.0.1:4317'): RecordedLink {
  const requests: LinkRequest[] = []
  return {
    requests,
    link: {
      endpoint,
      send: (request) => {
        requests.push(request)
        return Promise.resolve({ status: 202, body: { accepted: true } })
      },
    },
  }
}

/** Control plane de mentira: so o que o comando sob teste realmente chama. */
export function fakePlane(partial: Partial<ControlPlane>): ControlPlane {
  const missing = (name: string) => (): never => {
    throw new Error(`${name} nao esperado neste teste`)
  }
  return {
    persistence: undefined as never,
    // Leitura por padrao: um dublê que se declarasse dono esconderia justamente a recusa
    // que o comando sob teste precisa encontrar.
    access: 'readonly',
    lifecycle: 'open',
    registry: fakeRegistry([]),
    gates: undefined as never,
    clock: undefined as never,
    ids: undefined as never,
    deps: undefined as never,
    validateMission: missing('validateMission') as never,
    compileMission: missing('compileMission') as never,
    createRun: missing('createRun') as never,
    approveMission: missing('approveMission') as never,
    startRun: missing('startRun') as never,
    pauseRun: missing('pauseRun') as never,
    resumeRun: missing('resumeRun') as never,
    stopRun: missing('stopRun') as never,
    unblockTask: missing('unblockTask') as never,
    retryTask: missing('retryTask') as never,
    skipTask: missing('skipTask') as never,
    cancelTask: missing('cancelTask') as never,
    getRunSnapshot: missing('getRunSnapshot') as never,
    getTaskDetail: missing('getTaskDetail') as never,
    generateMissionReport: missing('generateMissionReport') as never,
    open: missing('open') as never,
    adoptRecoverableRuns: missing('adoptRecoverableRuns') as never,
    close: () => Promise.resolve(),
    ...partial,
  }
}

export interface ProjectOptions {
  readonly workspace?: 'git-worktree' | 'shared'
  readonly maxParallelTasks?: number
  readonly port?: number
}

export function projectYaml(options: ProjectOptions = {}): string {
  return `apiVersion: agentic/v1
kind: Project
project:
  name: projeto-de-teste
  repoRoot: .
execution:
  workspace: ${options.workspace ?? 'git-worktree'}
  worktreeRoot: .agentic/worktrees
  maxParallelTasks: ${options.maxParallelTasks ?? 2}
  maxExecutors: 2
  maxReviewers: 1
  defaultMaxAttempts: 3
  attemptTimeoutMinutes: 30
  retryBackoffSeconds: 5
  workspaceSetup:
    link: []
    commands: []
    timeoutMs: 60000
policies:
  enforceTouches: true
  requireReviewByDefault: false
  denyPaths: [.agentic/, .git/]
  escalateOn: [attemptsExhausted]
  review:
    default: fresh-session
    byRisk:
      low: fresh-session
      medium: fresh-session
      high: fresh-session
integration:
  missionBranchPrefix: mission/
  taskBranchPrefix: task/
  strategy: rebase-merge
  autoPush: false
providers:
  default: mock
  registry:
    mock:
      kind: inprocess
      maxConcurrent: 4
      roles: [executor, reviewer]
gates:
  file: .agentic/gates.yaml
  missionGate: mission
server:
  host: 127.0.0.1
  port: ${options.port ?? 4317}
`
}

export const GATES_YAML = `apiVersion: agentic/v1
kind: Gates
profiles:
  unit:
    commands:
      - run: node -e "process.exit(0)"
  mission:
    commands:
      - run: node -e "process.exit(0)"
env:
  allow: [PATH, HOME]
`

/** Missao valida, sem nenhum diagnostico: duas folhas cobertas pelo mission gate. */
export const VALID_MISSION = `apiVersion: agentic/v1
kind: Mission
id: TESTE-001
title: missao de teste da CLI
objective: exercitar os comandos sem agente real
acceptanceCriteria:
  - a CLI responde com codigo de saida correto
defaults:
  requireReview: false
  maxAttempts: 2
  gate: unit
phases:
  - id: base
    title: Base
  - id: fim
    title: Fim
tasks:
  - id: T01
    phase: base
    title: primeira task
    objective: entregar o contrato com prova
    dependencies: []
    touches: [src/base/]
    validation: [o gate da task passa]
    gate: unit
    risk: low
    estimate: 2
  - id: T02
    phase: fim
    title: segunda task
    objective: entregar a interface com prova
    dependencies: [T01]
    touches: [src/fim/]
    validation: [o gate da task passa]
    gate: mission
    risk: low
    estimate: 1
  - id: T03
    phase: fim
    title: terceira task
    objective: entregar o extra com prova
    dependencies: [T01]
    touches: [src/extra/]
    validation: [o gate da task passa]
    gate: mission
    risk: low
    estimate: 1
missionGate: mission
`

/** DA1003: dependencia inexistente — ERROR. */
export const MISSION_WITH_ERROR = VALID_MISSION.replace('dependencies: [T01]', 'dependencies: [T99]')

/** DA2005: touches de diretorio de topo — WARNING, sem ERROR. */
export const MISSION_WITH_WARNING = VALID_MISSION.replace('touches: [src/fim/]', 'touches: [docs/]')

export interface Workspace {
  readonly dir: string
  readonly missionPath: string
  write(relative: string, content: string): Promise<string>
  cleanup(): Promise<void>
}

export interface WorkspaceOptions extends ProjectOptions {
  readonly mission?: string
}

/** Projeto real em diretorio temporario: arquivos de verdade, nenhum agente de verdade. */
export async function createWorkspace(options: WorkspaceOptions = {}): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), 'agentic-cli-'))
  await mkdir(join(dir, '.agentic', 'missions'), { recursive: true })
  await writeFile(join(dir, '.agentic', 'project.yaml'), projectYaml(options), 'utf8')
  await writeFile(join(dir, '.agentic', 'gates.yaml'), GATES_YAML, 'utf8')
  const missionPath = join(dir, '.agentic', 'missions', 'TESTE-001.mission.yaml')
  await writeFile(missionPath, options.mission ?? VALID_MISSION, 'utf8')
  return {
    dir,
    missionPath,
    write: async (relative, content) => {
      const target = join(dir, relative)
      await writeFile(target, content, 'utf8')
      return target
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/** TaskDetail completo o bastante para exercitar o painel — worktree e branch incluidos. */
export const TASK_DETAIL: TaskDetail = {
  id: 'T05',
  title: 'Graph Compiler',
  objective: 'compilar a missao em grafo com diagnosticos',
  phase: 'compiler',
  status: 'REVIEW',
  graph: {
    dependencies: [{ id: 'T03', status: 'DONE' }],
    dependents: ['T10'],
    onCriticalPath: true,
  },
  scope: { touches: ['packages/compiler/'], reads: ['packages/domain/'], outOfScopePaths: [] },
  execution: {
    provider: 'mock',
    executor: {
      profileId: 'mock.executor',
      providerId: 'mock',
      sessionRef: 'sessao-1',
      startedAt: '2026-01-01T00:00:00.000Z',
    },
    attempt: { number: 1, max: 3 },
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 4200,
  },
  review: { policy: 'fresh-session', policyOutcome: 'satisfied', findings: [] },
  isolation: {
    kind: 'git-worktree',
    worktreePath: '/tmp/projeto/.agentic/worktrees/RUN/T05-a1',
    branch: 'task/TESTE-001/T05/a1',
    baseCommit: 'abc1234',
    commit: 'def5678',
  },
  quality: { validation: ['uma fixture por diagnostico'], gate: 'unit', commandResults: [] },
  facts: { filesChanged: [], diffStat: { files: 2, added: 40, removed: 3 }, evidence: [] },
  attempts: [
    {
      id: 'att-1',
      attemptNumber: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      worktreePath: '/tmp/projeto/.agentic/worktrees/RUN/T05-a1',
      branch: 'task/TESTE-001/T05/a1',
    },
  ],
  events: [],
}

/** RunSnapshot minimo e valido para exercitar a leitura sem banco. */
export const RUN_SNAPSHOT: RunSnapshot = {
  run: {
    id: RUN_ID,
    missionId: 'TESTE-001',
    status: 'RUNNING',
    timestamps: { createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:01:00.000Z' },
    policies: {
      maxParallelTasks: 2,
      maxExecutors: 2,
      maxReviewers: 1,
      defaultMaxAttempts: 3,
      attemptTimeoutMs: 1_800_000,
      retryBackoffMs: 5_000,
      workspaceMode: 'git-worktree',
      enforceTouches: true,
      denyPaths: ['.agentic/'],
    },
    missionGate: 'mission',
    integrationBranch: 'mission/TESTE-001',
  },
  graph: {
    nodes: [
      {
        id: 'T01',
        title: 'primeira task',
        phase: 'base',
        dependencies: [],
        touches: ['src/base/'],
        risk: 'low',
        estimate: 2,
      },
      {
        id: 'T02',
        title: 'segunda task',
        phase: 'fim',
        dependencies: ['T01'],
        touches: ['src/fim/'],
        risk: 'low',
        estimate: 1,
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
      durationMs: 4_000,
    },
    {
      id: 'T02',
      status: 'RUNNING',
      attemptCount: 1,
      unblockedBy: [],
    },
  ],
  counters: {
    PENDING: 0,
    READY: 0,
    RUNNING: 1,
    VERIFYING: 0,
    REVIEW: 0,
    INTEGRATING: 0,
    DONE: 1,
    FAILED: 0,
    RETRY: 0,
    BLOCKED: 0,
    SKIPPED: 0,
    CANCELLED: 0,
  },
  providers: [
    {
      providerId: 'mock',
      installed: true,
      ready: true,
      version: '1.0.0-mock',
      detail: 'agente in-process',
      running: 1,
      capacity: 4,
      probedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  metrics: {
    wallTimeMs: 60_000,
    attempts: 2,
    retries: 0,
    reviewFailures: 0,
    parallelismRatio: 0.5,
  },
}

/**
 * Run PERSISTIDO com tentativas em voo, sem agente nenhum.
 *
 * Existe para provar o `running` derivado do banco: um segundo processo (a CLI) precisa
 * enxergar os agentes que OUTRO processo despachou. O livro-caixa em memoria nunca
 * enxergaria.
 */
export interface InFlightSeed {
  readonly taskId: string
  readonly providerId: string
  readonly status?: 'RUNNING' | 'REVIEW'
}

const SEED_POLICIES = {
  maxParallelTasks: 2,
  maxExecutors: 2,
  maxReviewers: 1,
  defaultMaxAttempts: 3,
  attemptTimeoutMs: 1_800_000,
  retryBackoffMs: 5_000,
  workspaceMode: 'git-worktree' as const,
  enforceTouches: true,
  denyPaths: ['.agentic/'],
}

function seedTaskSpec(id: string, touches: string): never {
  return {
    id,
    phase: 'base',
    title: `task ${id}`,
    objective: `entregar ${id}`,
    dependencies: [],
    touches: [touches],
    validation: ['o gate passa'],
    risk: 'low',
    estimate: 1,
  } as never
}

export async function seedPersistedRun(
  dir: string,
  seeds: readonly InFlightSeed[],
  options: { readonly runStatus?: 'RUNNING' | 'COMPLETED' } = {},
): Promise<string> {
  const { openPersistence } = await import('@agentic/persistence')
  const persistence = openPersistence({ baseDir: join(dir, '.agentic') })
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const tasks = seeds.map((seed, index) => seedTaskSpec(seed.taskId, `src/${index}/`))
  const run = {
    id: RUN_ID,
    missionId: 'TESTE-001',
    specHash: 'hash-de-teste',
    graph: { specHash: 'hash-de-teste', tasks, edges: [], topologicalOrder: seeds.map((s) => s.taskId) },
    status: options.runStatus ?? 'RUNNING',
    policies: SEED_POLICIES,
    createdAt,
    startedAt: createdAt,
  } as never

  const taskRuns = seeds.map(
    (seed) =>
      ({
        runId: RUN_ID,
        taskId: seed.taskId,
        status: 'PENDING',
        attemptCount: 0,
        unblockedBy: [],
      }) as never,
  )

  try {
    await persistence.runs.createRun(run, taskRuns)
    for (const seed of seeds) {
      const attemptId = `${seed.taskId}-a1`
      const status = seed.status ?? 'RUNNING'
      const executor = {
        profileId: `${seed.providerId}.executor`,
        providerId: seed.providerId,
        sessionRef: `sessao-${seed.taskId}`,
        startedAt: createdAt,
      }
      await persistence.runs.withTransaction(async (uow) => {
        await uow.saveAttempt({
          id: attemptId,
          taskRunId: `${RUN_ID}:${seed.taskId}`,
          attemptNumber: 1,
          executor,
          dispatchReason: {
            dependenciesSatisfied: [],
            locksAcquired: [],
            providerId: seed.providerId,
            slot: 'executor',
            priority: 1,
          },
          workspace: { kind: 'git-worktree', path: `/tmp/${seed.taskId}` },
          startedAt: createdAt,
          gateExecutions: [],
        } as never)
        await uow.saveTaskRun({
          runId: RUN_ID,
          taskId: seed.taskId,
          status,
          attemptCount: 1,
          currentAttemptId: attemptId,
          unblockedBy: [],
          startedAt: createdAt,
        } as never)
        await uow.appendEvent({
          runId: RUN_ID,
          ts: createdAt,
          type: 'attempt.started',
          actor: { kind: 'orchestrator' },
          taskId: seed.taskId,
          attemptId,
          payload: { attemptNumber: 1, workspace: { kind: 'git-worktree', path: `/tmp/${seed.taskId}` } },
        } as never)
      })
    }
  } finally {
    persistence.close()
  }
  return RUN_ID
}
