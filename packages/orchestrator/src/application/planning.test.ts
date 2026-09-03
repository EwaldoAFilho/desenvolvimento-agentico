import type {
  MissionId,
  MissionPlanner,
  MissionPlannerRegistry,
  MissionSpec,
  PlanningCapabilities,
  PlanningRequest,
  PlanningResult,
  ProviderId,
} from '@agentic/domain'
import { gateId as toGateId, providerId as toProviderId } from '@agentic/domain'
import {
  missionFileFromPlan,
  parseMissionPlan,
  parseProjectFile,
  toMissionSpec,
} from '@agentic/schemas'
import { describe, expect, it } from 'vitest'
import { GATE_ALWAYS_PASS, gatesYaml, projectYaml } from '../engine/__fixtures__/files.js'
import { CommandRefusedError } from '../engine/index.js'
import type { ApplicationDeps } from './deps.js'
import type { MissionArtifactStore, PlanningDeps, RepoObserver } from './planning.js'
import { MissionFileExistsError, planMission } from './planning.js'

/**
 * Nenhum caminho exercitado aqui pode gravar estado: sao todos recusas ANTES do run existir.
 * Um store de mentira silencioso esconderia uma escrita indevida; este grita.
 */
const NEVER_TOUCHED = new Proxy({} as ApplicationDeps, {
  get: (_target, key): never => {
    throw new Error(`o caso de uso nao deveria tocar o estado do run (acessou ${String(key)})`)
  },
})

const PLANNER_ID = 'planejador-teste'
const PROJECT_TEXT = projectYaml()
const GATES_TEXT = gatesYaml({ unit: [GATE_ALWAYS_PASS] })

function projectFile() {
  const parsed = parseProjectFile(PROJECT_TEXT)
  if (!parsed.ok) throw new Error(`project.yaml invalido: ${JSON.stringify(parsed.issues)}`)
  return parsed.value
}

function specOf(plan: Record<string, unknown>): MissionSpec {
  const parsed = parseMissionPlan(JSON.stringify(plan))
  if (!parsed.ok) throw new Error(`plano invalido no teste: ${JSON.stringify(parsed.issues)}`)
  return toMissionSpec(missionFileFromPlan(parsed.value))
}

const PLAN: Record<string, unknown> = {
  id: 'DA-PLN-001',
  title: 'missao proposta por um planejador',
  objective: 'provar o caminho de recusa antes de gravar',
  acceptanceCriteria: ['nada e gravado quando o control plane recusa'],
  defaults: { requireReview: false, maxAttempts: 2, gate: 'unit' },
  phases: [{ id: 'build', title: 'Build' }],
  tasks: [
    {
      id: 'T01',
      phase: 'build',
      title: 'primeira entrega',
      objective: 'entregar T01 com prova',
      dependencies: [],
      touches: ['packages/t01/'],
      validation: ['o gate da task passa'],
      risk: 'low',
      estimate: 1,
    },
  ],
  missionGate: 'unit',
}

class CountingPlanner implements MissionPlanner {
  readonly id: ProviderId = toProviderId(PLANNER_ID)
  calls = 0

  constructor(private readonly capabilitiesValue: PlanningCapabilities) {}

  capabilities(): PlanningCapabilities {
    return this.capabilitiesValue
  }

  plan(_request: PlanningRequest): Promise<PlanningResult> {
    this.calls += 1
    return Promise.resolve({
      outcome: 'proposed',
      logsRef: `contagem:${this.calls}`,
      proposal: { mission: specOf(PLAN) },
    })
  }
}

const SIMULATED: PlanningCapabilities = {
  simulated: true,
  acceptsRevision: true,
  reportsUsage: false,
}

function registryOf(planner: MissionPlanner): MissionPlannerRegistry {
  return {
    get: () => planner,
    list: () => [planner.id],
    default: () => planner.id,
  }
}

interface DepsOptions {
  readonly planner: MissionPlanner
  readonly fingerprints?: readonly (string | undefined)[]
  readonly create?: MissionArtifactStore['create']
}

function depsOf(options: DepsOptions): PlanningDeps {
  const fingerprints = [...(options.fingerprints ?? ['limpo', 'limpo'])]
  const repo: RepoObserver = {
    fingerprint: () =>
      Promise.resolve(fingerprints.length > 1 ? fingerprints.shift() : fingerprints[0]),
  }
  const missions: MissionArtifactStore = {
    pathFor: (id: MissionId) => `.agentic/missions/${id}.mission.yaml`,
    taken: () => Promise.resolve([]),
    create: options.create ?? ((): Promise<void> => Promise.resolve()),
  }
  return {
    planners: registryOf(options.planner),
    missions,
    repo,
    sources: () => Promise.resolve({ projectText: PROJECT_TEXT, gatesText: GATES_TEXT }),
    project: projectFile(),
    gates: [toGateId('unit')],
    readRoot: '/tmp/projeto-que-nao-existe',
    timeoutMs: 1_000,
  }
}

const REQUEST = {
  prompt: 'faca a primeira fatia',
  actor: 'humano@teste',
  acceptsSubscriptionUse: true,
}

describe('planejamento so acontece sobre repositorio observavel', () => {
  it('sem observacao o control plane recusa antes de acionar o planejador', async () => {
    const planner = new CountingPlanner(SIMULATED)
    const result = await planMission(
      NEVER_TOUCHED,
      depsOf({ planner, fingerprints: [undefined] }),
      REQUEST,
    )

    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') return
    expect(result.failure.code).toBe('PLANNER_FAILED')
    expect(result.failure.message).toContain('observar o repositorio')
    // Nem o planejador foi acionado: nao se gasta assinatura para nao poder afirmar nada.
    expect(planner.calls).toBe(0)
  })

  it('observacao que se perde no meio do caminho tambem recusa', async () => {
    const planner = new CountingPlanner(SIMULATED)
    const result = await planMission(
      NEVER_TOUCHED,
      depsOf({ planner, fingerprints: ['limpo', undefined] }),
      REQUEST,
    )

    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') return
    expect(result.failure.message).toContain('deixou de ser observavel')
    expect(planner.calls).toBe(1)
  })
})

describe('escrita do artefato', () => {
  it('arquivo que aparece entre conferir e gravar recusa em vez de sobrescrever', async () => {
    const planner = new CountingPlanner(SIMULATED)
    const deps = depsOf({
      planner,
      create: () =>
        Promise.reject(new MissionFileExistsError('.agentic/missions/DA-PLN-001.mission.yaml')),
    })
    const result = await planMission(NEVER_TOUCHED, deps, REQUEST)

    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') return
    expect(result.failure.code).toBe('CONTRACT_REJECTED')
    expect(result.failure.message).toContain('nao sera sobrescrito')
  })

  it('falha inesperada de escrita sobe, em vez de virar plano vazio', async () => {
    const planner = new CountingPlanner(SIMULATED)
    const deps = depsOf({ planner, create: () => Promise.reject(new Error('disco cheio')) })

    await expect(planMission(NEVER_TOUCHED, deps, REQUEST)).rejects.toThrow('disco cheio')
  })
})

describe('recusas de comando', () => {
  it('pedido vazio nao aciona planejador', async () => {
    const planner = new CountingPlanner(SIMULATED)
    const deps = depsOf({ planner })

    await expect(planMission(NEVER_TOUCHED, deps, { ...REQUEST, prompt: '   ' })).rejects.toThrow(
      CommandRefusedError,
    )
    expect(planner.calls).toBe(0)
  })

  it('sem autor humano nao ha planejamento', async () => {
    const planner = new CountingPlanner(SIMULATED)
    const deps = depsOf({ planner })

    await expect(planMission(NEVER_TOUCHED, deps, { ...REQUEST, actor: ' ' })).rejects.toThrow(
      CommandRefusedError,
    )
    expect(planner.calls).toBe(0)
  })

  it('planejador real sem aceite de assinatura nao e acionado', async () => {
    const planner = new CountingPlanner({ ...SIMULATED, simulated: false })
    const deps = depsOf({ planner })

    await expect(
      planMission(NEVER_TOUCHED, deps, { ...REQUEST, acceptsSubscriptionUse: false }),
    ).rejects.toThrow(/assinatura/)
    expect(planner.calls).toBe(0)
  })
})
