import { join } from 'node:path'
import type { CompiledGraph } from '@agentic/compiler'
import { compileMission } from '@agentic/compiler'
import type { Attempt, DomainEvent, MissionSpec, Run, RunId, TaskRun } from '@agentic/domain'
import { isTerminalRunStatus, taskId as toTaskId } from '@agentic/domain'
import type { ControlPlane, Orchestrator } from '@agentic/orchestrator'
import { createControlPlane } from '@agentic/orchestrator'
import { acquireControlPlaneOwnership, type ControlPlaneLease } from '@agentic/persistence'
import type { ProviderFactory } from '@agentic/providers'
import type { GatesFile, ProjectFile } from '@agentic/schemas'
import { parseGatesFile, parseMissionFile, parseProjectFile, toMissionSpec } from '@agentic/schemas'
import type { ConcurrencyProbe, StepFn } from './agents.js'
import { missionStep, scriptedFactory } from './agents.js'
import type { Fixture, FixtureSources } from './fixture.js'
import { materializeFixture } from './fixture.js'

export const ACTOR = 'humano@estoque-cli'

export interface HarnessOptions {
  /** Roteiro dos agentes de mentira. Default: entrega o `touches` e aprova a revisao. */
  readonly step?: StepFn
  /** Transforma o project.yaml do fixture antes do commit inicial. */
  readonly project?: (text: string) => string
  /** Transforma o mission.yaml do fixture antes do commit inicial. */
  readonly mission?: (text: string) => string
  readonly probe?: ConcurrencyProbe
  /** Ausente = so tick por evento (usado quando o teste dirige o loop com `drain`). */
  readonly safetyIntervalMs?: number
  /** `false` deixa o run em DRAFT: usado para exercitar a recusa de partida. */
  readonly approve?: boolean
}

export interface MissionHarness {
  readonly root: string
  readonly fixture: Fixture
  readonly sources: FixtureSources
  readonly plane: ControlPlane
  /**
   * A posse do projeto que este harness detem (I14). Exposta porque um teste que entrega o
   * projeto a OUTRO control plane precisa soltar a posse antes — e precisa que isso apareca
   * no teste, nao aconteca em silencio.
   */
  readonly lease: ControlPlaneLease
  readonly runId: RunId
  readonly orchestrator: Orchestrator
  readonly mission: MissionSpec
  readonly compiled: CompiledGraph
  readonly project: ProjectFile
  readonly gatesFile: GatesFile
  git(...args: string[]): Promise<string>
  /** START MISSION pelo caso de uso do control plane. O despacho continua sendo do loop. */
  start(options?: { readonly acceptWarnings?: boolean }): Promise<Run>
  /** Dirige o loop ate nao haver mais trabalho pendente (sem timer, sem espera cega). */
  drain(): Promise<void>
  run(): Promise<Run>
  tasks(): Promise<TaskRun[]>
  task(id: string): Promise<TaskRun>
  attempts(id?: string): Promise<Attempt[]>
  events(): Promise<DomainEvent[]>
  eventTypes(): Promise<string[]>
  /** Espera o run satisfazer o predicado. Falha com o retrato do run, nunca em silencio. */
  waitFor(predicate: (run: Run) => boolean, label: string, timeoutMs?: number): Promise<Run>
  waitForTerminal(timeoutMs?: number): Promise<Run>
  reopen(step?: StepFn): Promise<MissionHarness>
  cleanup(): Promise<void>
}

function factoriesOf(
  project: ProjectFile,
  step: StepFn,
  probe?: ConcurrencyProbe,
): Record<string, ProviderFactory> {
  // A substituicao e total e deliberada: nenhum adapter de CLI real chega a ser
  // construido, entao nenhum teste automatizado pode invocar agente real ou gastar quota.
  const factories: Record<string, ProviderFactory> = {}
  for (const id of Object.keys(project.providers.registry)) {
    factories[id] = scriptedFactory(step, probe)
  }
  return factories
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Repositorio git real e temporario a partir de `examples/estoque-cli` + control plane
 * completo sobre banco proprio. Todo agente e o provider mock roteirizado: sem CLI, sem
 * rede, sem quota.
 */
export async function createMissionHarness(options: HarnessOptions = {}): Promise<MissionHarness> {
  const fixture = await materializeFixture({
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.mission === undefined ? {} : { mission: options.mission }),
  })
  const sources = fixture.sources
  const step = options.step ?? missionStep

  const projectParsed = parseProjectFile(sources.projectText)
  if (!projectParsed.ok) {
    throw new Error(`project.yaml invalido: ${JSON.stringify(projectParsed.issues)}`)
  }
  const gatesParsed = parseGatesFile(sources.gatesText)
  if (!gatesParsed.ok) {
    throw new Error(`gates.yaml invalido: ${JSON.stringify(gatesParsed.issues)}`)
  }
  const missionParsed = parseMissionFile(sources.missionText)
  if (!missionParsed.ok) {
    throw new Error(`mission.yaml invalido: ${JSON.stringify(missionParsed.issues)}`)
  }

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

  /**
   * O harness e DONO do projeto, como um control plane de verdade (I14).
   *
   * Nao e cerimonia: `adoptRecoverableRuns()` recusa em plane sem posse declarada, e um
   * harness sem posse testaria um caminho que nao existe em producao. O mesmo lease
   * atravessa `reopen`, porque reabrir e o mesmo processo continuando dono — tentar
   * adquirir de novo bateria no proprio lock.
   */
  const posse = acquireControlPlaneOwnership({ baseDir: join(fixture.root, '.agentic') })
  if (!posse.ok) {
    await fixture.cleanup()
    throw new Error(`harness: nao consegui a posse do fixture (${posse.detail})`)
  }
  const lease: ControlPlaneLease = posse.lease

  const build = (activeStep: StepFn): ControlPlane =>
    createControlPlane({
      project: projectParsed.value,
      gatesFile: gatesParsed.value,
      repoRoot: fixture.root,
      lease,
      providerFactories: factoriesOf(projectParsed.value, activeStep, options.probe),
      ...(options.safetyIntervalMs === undefined
        ? {}
        : { safetyIntervalMs: options.safetyIntervalMs }),
    })

  const plane = build(step)
  const created = await plane.createRun({
    mission,
    compiled: graph,
    missionText: sources.missionText,
  })
  if (options.approve !== false) {
    await plane.approveMission({ runId: created.id, actor: ACTOR })
  }
  const orchestrator = await plane.open(created.id)

  const make = (activePlane: ControlPlane, activeOrchestrator: Orchestrator): MissionHarness => {
    const loadRun = async (): Promise<Run> => {
      const loaded = await activePlane.persistence.runs.loadRun(created.id)
      if (loaded === undefined) throw new Error('run sumiu do banco')
      return loaded
    }

    const waitFor = async (
      predicate: (run: Run) => boolean,
      label: string,
      timeoutMs = 60_000,
    ): Promise<Run> => {
      const deadline = Date.now() + timeoutMs
      let last = await loadRun()
      while (!predicate(last)) {
        if (Date.now() > deadline) {
          const tasks = await activePlane.persistence.runs.loadTaskRuns(created.id)
          const retrato = tasks.map((task) => `${task.taskId}=${task.status}`).join(' ')
          throw new Error(
            `esperei ${label} por ${timeoutMs}ms; run=${last.status} tasks: ${retrato}; ` +
              `erros do loop: ${JSON.stringify(activeOrchestrator.errors.map(String))}`,
          )
        }
        await sleep(20)
        last = await loadRun()
      }
      return last
    }

    return {
      root: fixture.root,
      fixture,
      sources,
      plane: activePlane,
      lease,
      runId: created.id,
      orchestrator: activeOrchestrator,
      mission,
      compiled: graph,
      project: projectParsed.value,
      gatesFile: gatesParsed.value,
      git: fixture.git,
      start: (startOptions = {}) =>
        activePlane.startRun({
          runId: created.id,
          actor: ACTOR,
          acceptWarnings: startOptions.acceptWarnings ?? false,
        }),
      drain: () => activeOrchestrator.drain(),
      run: loadRun,
      tasks: () => activePlane.persistence.runs.loadTaskRuns(created.id),
      task: async (id: string): Promise<TaskRun> => {
        const tasks = await activePlane.persistence.runs.loadTaskRuns(created.id)
        const found = tasks.find((task) => task.taskId === toTaskId(id))
        if (found === undefined) throw new Error(`task ${id} nao existe no run`)
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
      waitFor,
      waitForTerminal: (timeoutMs?: number) =>
        waitFor((run) => isTerminalRunStatus(run.status), 'o run terminar', timeoutMs),
      reopen: async (nextStep?: StepFn): Promise<MissionHarness> => {
        await activePlane.close()
        const reopened = build(nextStep ?? step)
        return make(reopened, await reopened.open(created.id))
      },
      cleanup: async (): Promise<void> => {
        await activePlane.close().catch(() => undefined)
        // A posse sai por ultimo: enquanto houver plane aberto, o projeto tem dono.
        lease.release()
        await fixture.cleanup()
      },
    }
  }

  return make(plane, orchestrator)
}
