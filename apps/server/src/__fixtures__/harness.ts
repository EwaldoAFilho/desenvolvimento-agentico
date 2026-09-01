import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProviderRegistry, RunId } from '@agentic/domain'
import type { ControlPlane, Orchestrator } from '@agentic/orchestrator'
import { createControlPlane } from '@agentic/orchestrator'
import { acquireControlPlaneOwnership, type ControlPlaneLease } from '@agentic/persistence'
import type { GatesFile, ProjectFile } from '@agentic/schemas'
import { parseGatesFile, parseProjectFile } from '@agentic/schemas'
import type { FastifyInstance } from 'fastify'
import type { RunLauncher, ServerDeps } from '../deps.js'
import { toServerDeps } from '../deps.js'
import { createServer } from '../server.js'
import {
  CLEAN_MISSION,
  GATE_ALWAYS_PASS,
  type MissionFixture,
  type ProjectFixture,
  gatesYaml,
  missionYaml,
  projectYaml,
} from './files.js'

const exec = promisify(execFile)

export const ACTOR = 'humano@teste'

export interface MockStepFixture {
  readonly status: 'completed'
  readonly claims: { readonly summary: string }
  readonly writeFiles: Readonly<Record<string, string>>
}

/** Roteiro do agente de mentira: escreve dentro do `touches` declarado da task. */
export function mockScripts(
  tasks: readonly string[],
): Readonly<Record<string, Readonly<Record<string, MockStepFixture>>>> {
  const script: Record<string, MockStepFixture> = {}
  for (const task of tasks) {
    script[task] = {
      status: 'completed',
      claims: { summary: `${task}: alteracao aplicada` },
      writeFiles: {
        [`packages/${task.toLowerCase()}/${task}.ts`]: `export const ${task} = 1\n`,
      },
    }
  }
  return { mock: script }
}

export interface HarnessOptions {
  readonly missions?: readonly MissionFixture[]
  readonly project?: ProjectFixture
  readonly gates?: Readonly<Record<string, readonly string[]>>
  /** Registry alternativo — usado para provar que `unknown` atravessa como `unknown`. */
  readonly registry?: ProviderRegistry
  readonly webDist?: string
  readonly heartbeatMs?: number
  /** Por padrao o launcher e um espiao: o teste dirige o loop na mao com `drain`. */
  readonly realLauncher?: boolean
}

export interface ServerHarness {
  readonly root: string
  readonly app: FastifyInstance
  readonly plane: ControlPlane
  /**
   * A posse do projeto que este harness detem (I14). Exposta porque um teste cujo dono e
   * OUTRO processo (`startServer`) precisa devolver o projeto antes — e precisa que isso
   * apareca no teste, nao aconteca em silencio.
   */
  readonly lease: ControlPlaneLease
  readonly deps: ServerDeps
  readonly project: ProjectFile
  readonly gatesFile: GatesFile
  /** Runs cuja orquestracao o servidor mandou comecar. */
  readonly launched: RunId[]
  missionFile(id: string): string
  open(runId: string): Promise<Orchestrator>
  drain(runId: string): Promise<void>
  cleanup(): Promise<void>
}

async function seedRepository(root: string): Promise<void> {
  const git = async (...args: string[]): Promise<void> => {
    await exec('git', args, { cwd: root })
  }
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.name', 'Orquestrador Teste')
  await git('config', 'user.email', 'teste@example.invalid')
  await git('config', 'commit.gpgsign', 'false')
  await writeFile(join(root, '.gitignore'), '.agentic/\nnode_modules/\n', 'utf8')
  await writeFile(join(root, 'README.md'), 'base\n', 'utf8')
  await git('add', '-A')
  await git('commit', '--no-verify', '-q', '-m', 'init')
}

/**
 * Repositorio git temporario + control plane real sobre banco proprio + servidor por
 * `inject`. Nenhuma porta e aberta e nenhum agente real e invocado: todo agente e o mock.
 */
export async function createServerHarness(
  options: HarnessOptions = {},
): Promise<ServerHarness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentic-server-')))
  await seedRepository(root)
  await mkdir(join(root, '.agentic', 'missions'), { recursive: true })

  const projectText = projectYaml(options.project)
  const gatesText = gatesYaml(options.gates ?? { unit: [GATE_ALWAYS_PASS] })
  await writeFile(join(root, '.agentic', 'project.yaml'), projectText, 'utf8')
  await writeFile(join(root, '.agentic', 'gates.yaml'), gatesText, 'utf8')

  const missions = options.missions ?? [CLEAN_MISSION]
  const taskIds = new Set<string>()
  for (const mission of missions) {
    const id = mission.id ?? 'DA-SRV-001'
    await writeFile(
      join(root, '.agentic', 'missions', `${id}.mission.yaml`),
      missionYaml(mission),
      'utf8',
    )
    for (const task of mission.tasks) taskIds.add(task.id)
  }

  const project = parseProjectFile(projectText)
  if (!project.ok) throw new Error(`project.yaml invalido: ${JSON.stringify(project.issues)}`)
  const gates = parseGatesFile(gatesText)
  if (!gates.ok) throw new Error(`gates.yaml invalido: ${JSON.stringify(gates.issues)}`)

  // O harness e DONO do projeto, como `startServer` (I14): sem posse declarada o plane
  // recusa criar run, aprovar missao, iniciar run e abrir orquestrador.
  const posse = acquireControlPlaneOwnership({ baseDir: join(root, '.agentic') })
  if (!posse.ok) throw new Error(`harness: nao consegui a posse do fixture (${posse.detail})`)
  const lease = posse.lease

  const plane = createControlPlane({
    project: project.value,
    gatesFile: gates.value,
    repoRoot: root,
    baseDir: join(root, '.agentic'),
    lease,
    safetyIntervalMs: 0,
    scripts: mockScripts([...taskIds]),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  })

  const launched: RunId[] = []
  const spy: RunLauncher = {
    start: async (runId: RunId): Promise<void> => {
      launched.push(runId)
    },
  }

  const deps = toServerDeps({
    plane,
    project: project.value,
    projectText,
    gatesText,
    repoRoot: root,
    ...(options.webDist === undefined ? {} : { webDist: options.webDist }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.realLauncher === true ? {} : { launcher: spy }),
  })
  const app = createServer(deps)

  return {
    root,
    app,
    plane,
    lease,
    deps,
    project: project.value,
    gatesFile: gates.value,
    launched,
    missionFile: (id: string): string => `.agentic/missions/${id}.mission.yaml`,
    open: (runId: string) => plane.open(runId as RunId),
    drain: async (runId: string): Promise<void> => {
      const orchestrator = await plane.open(runId as RunId)
      await orchestrator.drain()
    },
    cleanup: async (): Promise<void> => {
      await app.close().catch(() => undefined)
      await plane.close().catch(() => undefined)
      // Idempotente: um teste que ja devolveu o projeto ao `startServer` passa por aqui sem
      // efeito, e um que nao devolveu solta a posse no fim.
      lease.release()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** Marca uma task como em voo no BANCO, sem agente algum: estado + evento na mesma transacao. */
export interface InFlightSeed {
  readonly taskId: string
  readonly providerId: string
  /** `REVIEW` grava tambem o `review.requested` que identifica o fornecedor do revisor. */
  readonly status?: 'RUNNING' | 'REVIEW'
  readonly reviewerProviderId?: string
  /** Tentativa ja encerrada: o controle de "task em voo mas processo morto". */
  readonly finished?: boolean
}

export async function seedInFlightAttempt(
  harness: ServerHarness,
  runId: string,
  seed: InFlightSeed,
): Promise<string> {
  const id = runId as RunId
  const taskId = seed.taskId as never
  const store = harness.plane.persistence.runs
  const taskRuns = await store.loadTaskRuns(id)
  const taskRun = taskRuns.find((task) => task.taskId === taskId)
  if (taskRun === undefined) throw new Error(`task ${seed.taskId} nao existe no run ${runId}`)
  const attemptId = `${seed.taskId}-a1-seed` as never // ATTEMPT_ID_PATTERN aceita este formato
  const startedAt = new Date('2026-01-01T00:00:00.000Z')
  const status = seed.status ?? 'RUNNING'
  const executor = {
    profileId: `${seed.providerId}.executor` as never,
    providerId: seed.providerId as never,
    sessionRef: `sessao-${seed.taskId}`,
    startedAt,
  }

  await store.withTransaction(async (uow) => {
    await uow.saveAttempt({
      id: attemptId,
      taskRunId: `${runId}:${seed.taskId}` as never,
      attemptNumber: 1,
      executor,
      dispatchReason: {
        dependenciesSatisfied: [],
        locksAcquired: [],
        providerId: seed.providerId as never,
        slot: 'executor',
        priority: 1,
      },
      workspace: { kind: 'git-worktree', path: `/tmp/${seed.taskId}`, branch: `task/${seed.taskId}` },
      startedAt,
      ...(seed.finished === true ? { finishedAt: startedAt, durationMs: 1 } : {}),
      gateExecutions: [],
    })
    await uow.saveTaskRun({
      ...taskRun,
      status,
      attemptCount: 1,
      currentAttemptId: attemptId,
      startedAt,
    })
    await uow.appendEvent({
      runId: id,
      ts: startedAt,
      type: 'attempt.started',
      actor: { kind: 'orchestrator' },
      taskId,
      attemptId,
      payload: { attemptNumber: 1, workspace: { kind: 'git-worktree', path: `/tmp/${seed.taskId}` } },
    })
    if (status === 'REVIEW') {
      await uow.appendEvent({
        runId: id,
        ts: startedAt,
        type: 'review.requested',
        actor: { kind: 'orchestrator' },
        taskId,
        attemptId,
        payload: {
          policy: 'fresh-session',
          reviewer: {
            ...executor,
            profileId: 'revisor' as never,
            providerId: (seed.reviewerProviderId ?? seed.providerId) as never,
            sessionRef: `revisao-${seed.taskId}`,
          },
        },
      })
    }
  })
  return attemptId
}
