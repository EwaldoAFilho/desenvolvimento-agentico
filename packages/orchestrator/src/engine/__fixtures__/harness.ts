import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { CompiledGraph } from '@agentic/compiler'
import { compileMission } from '@agentic/compiler'
import type {
  Attempt,
  DomainEvent,
  MissionSpec,
  Run,
  RunId,
  TaskId,
  TaskRun,
} from '@agentic/domain'
import { taskId as toTaskId } from '@agentic/domain'
import type { ProviderFactory } from '@agentic/providers'
import type { GatesFile, ProjectFile } from '@agentic/schemas'
import { parseGatesFile, parseMissionFile, parseProjectFile, toMissionSpec } from '@agentic/schemas'
import { type ControlPlane, createControlPlane } from '../control-plane.js'
import type { Orchestrator } from '../orchestrator.js'
import { type ConcurrencyProbe, pass, review, scriptedFactory, type StepFn } from './agents.js'
import {
  GATE_ALWAYS_PASS,
  gatesYaml,
  type MissionFixture,
  missionYaml,
  type ProjectFixture,
  projectYaml,
} from './files.js'

const exec = promisify(execFile)

export const DEFAULT_ACTOR = 'humano@teste'

/** Roteiro padrao: executor escreve no escopo declarado, revisor aprova. */
export const defaultStep: StepFn = (context) => {
  if (context.kind === 'review') return review('PASS')
  return pass(`${context.taskId}: alteracao aplicada`, {
    [`packages/${context.taskId.toLowerCase()}/${context.taskId}.ts`]: `export const ${context.taskId} = ${context.attemptNumber}\n`,
  })
}

export interface HarnessOptions {
  readonly mission: MissionFixture
  readonly project?: ProjectFixture
  readonly gates?: Readonly<Record<string, readonly string[]>>
  readonly step?: StepFn
  readonly approve?: boolean
  readonly start?: boolean
  readonly acceptWarnings?: boolean
  readonly probe?: ConcurrencyProbe
  /** Timer de seguranca do tick. Ausente = so tick por evento. */
  readonly safetyIntervalMs?: number
  /** Substitui o provider de TODOS os ids do registry — usado pelo executavel falso. */
  readonly factory?: ProviderFactory
}

export interface Harness {
  readonly root: string
  readonly plane: ControlPlane
  readonly runId: RunId
  readonly orchestrator: Orchestrator
  readonly mission: MissionSpec
  readonly compiled: CompiledGraph
  readonly project: ProjectFile
  readonly gatesFile: GatesFile
  git(...args: string[]): Promise<string>
  run(): Promise<Run>
  tasks(): Promise<TaskRun[]>
  task(id: string): Promise<TaskRun>
  attempts(id?: string): Promise<Attempt[]>
  events(): Promise<DomainEvent[]>
  eventTypes(): Promise<string[]>
  reopen(step?: StepFn): Promise<Harness>
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

interface Sources {
  readonly missionText: string
  readonly projectText: string
  readonly gatesText: string
}

function sourcesOf(options: HarnessOptions): Sources {
  return {
    missionText: missionYaml(options.mission),
    projectText: projectYaml(options.project),
    gatesText: gatesYaml(options.gates ?? { unit: [GATE_ALWAYS_PASS] }),
  }
}

function factoriesOf(
  project: ProjectFile,
  step: StepFn,
  probe?: ConcurrencyProbe,
  override?: ProviderFactory,
): Record<string, ProviderFactory> {
  const factories: Record<string, ProviderFactory> = {}
  for (const id of Object.keys(project.providers.registry)) {
    factories[id] = override ?? scriptedFactory(step, probe)
  }
  return factories
}

/**
 * Repositorio git real e temporario + control plane completo. Nenhuma CLI de agente e
 * nenhuma quota: todo agente e o provider mock, roteirizado por task e tentativa.
 */
export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentic-orch-')))
  await seedRepository(root)
  const sources = sourcesOf(options)
  const step = options.step ?? defaultStep

  const projectParsed = parseProjectFile(sources.projectText)
  if (!projectParsed.ok) throw new Error(`project.yaml invalido: ${JSON.stringify(projectParsed.issues)}`)
  const gatesParsed = parseGatesFile(sources.gatesText)
  if (!gatesParsed.ok) throw new Error(`gates.yaml invalido: ${JSON.stringify(gatesParsed.issues)}`)
  const missionParsed = parseMissionFile(sources.missionText)
  if (!missionParsed.ok) throw new Error(`mission.yaml invalido: ${JSON.stringify(missionParsed.issues)}`)

  const compiled = compileMission({
    missionText: sources.missionText,
    projectFile: sources.projectText,
    gatesFile: sources.gatesText,
  })
  const graph = compiled.graph
  if (graph === undefined) {
    throw new Error(`missao nao compilou: ${JSON.stringify(compiled.diagnostics)}`)
  }
  const mission = toMissionSpec(missionParsed.value)

  const build = (activeStep: StepFn): ControlPlane =>
    createControlPlane({
      project: projectParsed.value,
      gatesFile: gatesParsed.value,
      repoRoot: root,
      baseDir: join(root, '.agentic'),
      providerFactories: factoriesOf(
        projectParsed.value,
        activeStep,
        options.probe,
        options.factory,
      ),
      ...(options.safetyIntervalMs === undefined
        ? {}
        : { safetyIntervalMs: options.safetyIntervalMs }),
    })

  const plane = build(step)
  const created = await plane.createRun({ mission, compiled: graph, missionText: sources.missionText })
  if (options.approve !== false) {
    await plane.approveMission({ runId: created.id, actor: DEFAULT_ACTOR })
  }
  if (options.start !== false && options.approve !== false) {
    await plane.startRun({
      runId: created.id,
      actor: DEFAULT_ACTOR,
      acceptWarnings: options.acceptWarnings ?? true,
    })
  }
  const orchestrator = await plane.open(created.id)

  const make = (activePlane: ControlPlane, activeOrchestrator: Orchestrator): Harness => ({
    root,
    plane: activePlane,
    runId: created.id,
    orchestrator: activeOrchestrator,
    mission,
    compiled: graph,
    project: projectParsed.value,
    gatesFile: gatesParsed.value,
    git: async (...args: string[]): Promise<string> => {
      const { stdout } = await exec('git', args, { cwd: root, encoding: 'utf8' })
      return stdout.trim()
    },
    run: async (): Promise<Run> => {
      const loaded = await activePlane.persistence.runs.loadRun(created.id)
      if (loaded === undefined) throw new Error('run sumiu do banco')
      return loaded
    },
    tasks: () => activePlane.persistence.runs.loadTaskRuns(created.id),
    task: async (id: string): Promise<TaskRun> => {
      const tasks = await activePlane.persistence.runs.loadTaskRuns(created.id)
      const found = tasks.find((task) => task.taskId === (id as TaskId))
      if (found === undefined) throw new Error(`task ${id} nao existe`)
      return found
    },
    attempts: (id?: string) =>
      activePlane.persistence.runs.loadAttempts(
        created.id,
        id === undefined ? undefined : toTaskId(id),
      ),
    events: () => activePlane.persistence.events.list(created.id),
    eventTypes: async (): Promise<string[]> => {
      const events = await activePlane.persistence.events.list(created.id)
      return events.map((event) => event.type)
    },
    reopen: async (nextStep?: StepFn): Promise<Harness> => {
      await activePlane.close()
      const reopened = build(nextStep ?? step)
      const next = await reopened.open(created.id)
      return make(reopened, next)
    },
    cleanup: async (): Promise<void> => {
      await activePlane.close().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    },
  })

  return make(plane, orchestrator)
}

export async function writeInRepo(root: string, relative: string, content: string): Promise<void> {
  const target = join(root, relative)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}
