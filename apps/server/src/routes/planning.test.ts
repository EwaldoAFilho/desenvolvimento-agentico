import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  MissionPlanner,
  MissionPlannerRegistry,
  MissionSpec,
  PlanningCapabilities,
  PlanningFailureCode,
  PlanningRequest,
  PlanningResult,
  ProviderId,
  RunId,
} from '@agentic/domain'
import { providerId as toProviderId } from '@agentic/domain'
import type { ControlPlane } from '@agentic/orchestrator'
import { createControlPlane } from '@agentic/orchestrator'
import {
  missionFileFromPlan,
  PlanMissionResultDtoSchema,
  PlannerDtoSchema,
  PlanningFailureDtoSchema,
  parseGatesFile,
  parseMissionPlan,
  parseProjectFile,
  toMissionSpec,
} from '@agentic/schemas'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { GATE_ALWAYS_PASS, gatesYaml, projectYaml } from '../__fixtures__/files.js'
import { toServerDeps } from '../deps.js'
import { createServer } from '../server.js'

const exec = promisify(execFile)

const ACTOR = 'humano@teste'
const PLANNER_ID = 'planejador-teste'
const NEW_MISSION = 'DA-NEW-001'
const NEW_MISSION_FILE = `.agentic/missions/${NEW_MISSION}.mission.yaml`

// --------------------------------------------------------------------------------------
// Planejador de mentira
// --------------------------------------------------------------------------------------

/**
 * Um passo por chamada de `plan()`: o indice 0 e a primeira proposta, os demais sao as
 * correcoes. `writes` encena o planejador que desobedece e altera o repositorio — o unico
 * jeito de provar que o control plane confere o que mediu, e nao o que a CLI prometeu.
 */
interface Step {
  readonly plan?: Record<string, unknown>
  readonly failWith?: PlanningFailureCode
  readonly writes?: { readonly path: string; readonly text: string }
}

/** O MESMO caminho que o adapter real percorre: plano -> contrato -> `MissionSpec`. */
function specOf(plan: Record<string, unknown>): MissionSpec {
  const parsed = parseMissionPlan(JSON.stringify(plan))
  if (!parsed.ok) throw new Error(`plano de teste invalido: ${JSON.stringify(parsed.issues)}`)
  return toMissionSpec(missionFileFromPlan(parsed.value))
}

class FakePlanner implements MissionPlanner {
  readonly id: ProviderId
  /** Toda chamada fica registrada: quantas foram e o que cada uma pediu de correcao. */
  readonly requests: PlanningRequest[] = []
  readonly #root: string
  readonly #steps: readonly Step[]
  readonly #capabilities: PlanningCapabilities

  constructor(
    root: string,
    steps: readonly Step[],
    capabilities: Partial<PlanningCapabilities> = {},
  ) {
    this.id = toProviderId(PLANNER_ID)
    this.#root = root
    this.#steps = steps
    this.#capabilities = {
      simulated: true,
      acceptsRevision: true,
      reportsUsage: false,
      ...capabilities,
    }
  }

  capabilities(): PlanningCapabilities {
    return this.#capabilities
  }

  async plan(request: PlanningRequest): Promise<PlanningResult> {
    const index = this.requests.length
    this.requests.push(request)
    const step = this.#steps[index] ?? this.#steps.at(-1)
    const logsRef = `fake-plan:${index}`
    if (step?.writes !== undefined) {
      await writeFile(join(this.#root, step.writes.path), step.writes.text, 'utf8')
    }
    if (step?.plan === undefined) {
      const code = step?.failWith ?? 'NO_PROPOSAL'
      return {
        outcome: 'refused',
        logsRef,
        failure: { code, message: `roteiro encenou ${code}`, problems: [] },
      }
    }
    return {
      outcome: 'proposed',
      logsRef,
      proposal: { mission: specOf(step.plan), rationale: 'dividi em uma task porque cabe numa' },
    }
  }
}

function registryOf(planners: readonly MissionPlanner[]): MissionPlannerRegistry {
  return {
    get: (id) => {
      const found = planners.find((planner) => String(planner.id) === String(id))
      if (found === undefined) throw new Error(`planejador ${id} desconhecido`)
      return found
    },
    list: () => planners.map((planner) => planner.id),
    default: () => planners[0]?.id,
  }
}

// --------------------------------------------------------------------------------------
// Planos
// --------------------------------------------------------------------------------------

interface PlanOptions {
  readonly id?: string
  readonly title?: string
  /** Gate da task. `nao-existe` reprova em DA1007 antes de qualquer escrita. */
  readonly gate?: string
}

function planOf(options: PlanOptions = {}): Record<string, unknown> {
  return {
    id: options.id ?? NEW_MISSION,
    title: options.title ?? 'nova missao proposta por texto livre',
    objective: 'provar que o pedido do humano vira rascunho compilado',
    acceptanceCriteria: ['o rascunho aparece com o DAG compilado'],
    defaults: { requireReview: false, maxAttempts: 2, gate: 'unit' },
    phases: [{ id: 'build', title: 'Build' }],
    tasks: [
      {
        id: 'T01',
        phase: 'build',
        title: 'primeira entrega',
        objective: 'entregar T01 com prova observada',
        dependencies: [],
        touches: ['packages/t01/'],
        validation: ['o gate da task passa'],
        gate: options.gate,
        risk: 'low',
        estimate: 1,
      },
    ],
    missionGate: 'unit',
  }
}

// --------------------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------------------

interface HarnessOptions {
  readonly steps: readonly Step[]
  readonly capabilities?: Partial<PlanningCapabilities>
  /** Missoes que ja existem no repositorio antes de planejar. */
  readonly seeded?: Readonly<Record<string, string>>
  /** Sem planejador nenhum: o projeto que nao declarou CLI capaz de planejar. */
  readonly noPlanners?: boolean
}

interface PlanningHarness {
  readonly root: string
  readonly app: FastifyInstance
  readonly plane: ControlPlane
  readonly planner: FakePlanner
  /** Estado do repositorio como o git ve — a mesma medida que o control plane usa. */
  status(): Promise<string[]>
  cleanup(): Promise<void>
}

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: root })
  return stdout
}

async function createPlanningHarness(options: HarnessOptions): Promise<PlanningHarness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentic-plan-')))
  await git(root, 'init', '-q', '-b', 'main')
  await git(root, 'config', 'user.name', 'Orquestrador Teste')
  await git(root, 'config', 'user.email', 'teste@example.invalid')
  await git(root, 'config', 'commit.gpgsign', 'false')

  // So o estado local do control plane fica de fora do versionamento. `.agentic/missions/`
  // continua versionado de proposito: e assim que o artefato gravado aparece no `git status`
  // e da para afirmar que NADA mais mudou.
  await writeFile(
    join(root, '.gitignore'),
    '.agentic/state.db\n.agentic/state.db-*\n.agentic/runs/\nnode_modules/\n',
    'utf8',
  )
  await mkdir(join(root, '.agentic', 'missions'), { recursive: true })

  const projectText = projectYaml()
  const gatesText = gatesYaml({ unit: [GATE_ALWAYS_PASS] })
  await writeFile(join(root, '.agentic', 'project.yaml'), projectText, 'utf8')
  await writeFile(join(root, '.agentic', 'gates.yaml'), gatesText, 'utf8')
  for (const [id, text] of Object.entries(options.seeded ?? {})) {
    await writeFile(join(root, '.agentic', 'missions', `${id}.mission.yaml`), text, 'utf8')
  }
  await writeFile(join(root, 'README.md'), 'base\n', 'utf8')
  await git(root, 'add', '-A')
  await git(root, 'commit', '--no-verify', '-q', '-m', 'init')

  const project = parseProjectFile(projectText)
  if (!project.ok) throw new Error(`project.yaml invalido: ${JSON.stringify(project.issues)}`)
  const gates = parseGatesFile(gatesText)
  if (!gates.ok) throw new Error(`gates.yaml invalido: ${JSON.stringify(gates.issues)}`)

  const planner = new FakePlanner(root, options.steps, options.capabilities)
  const plane = createControlPlane({
    project: project.value,
    gatesFile: gates.value,
    projectText,
    gatesText,
    repoRoot: root,
    baseDir: join(root, '.agentic'),
    planners: registryOf(options.noPlanners === true ? [] : [planner]),
    safetyIntervalMs: 0,
  })

  const deps = toServerDeps({
    plane,
    project: project.value,
    projectText,
    gatesText,
    repoRoot: root,
    launcher: { start: () => Promise.resolve() },
  })

  return {
    root,
    app: createServer(deps),
    plane,
    planner,
    status: async (): Promise<string[]> => {
      const raw = await git(root, 'status', '--porcelain', '--untracked-files=all')
      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    },
    cleanup: async (): Promise<void> => {
      await plane.close().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    },
  }
}

let harness: PlanningHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

interface PlanBody {
  readonly prompt?: string
  readonly actor?: string
  readonly acceptsSubscriptionUse?: boolean
  readonly plannerId?: string
}

function planRequest(app: FastifyInstance, body: PlanBody = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/missions/plan',
    payload: {
      prompt: 'quero uma missao que entregue a primeira fatia com prova',
      actor: ACTOR,
      acceptsSubscriptionUse: true,
      ...body,
    },
  })
}

async function runsOf(harness: PlanningHarness): Promise<number> {
  return harness.plane.persistence.queries.listRuns({}).length
}

describe('planejamento de missao', () => {
  it('texto livre vira missao gravada pelo control plane e compilada automaticamente', async () => {
    harness = await createPlanningHarness({ steps: [{ plan: planOf() }] })
    const response = await planRequest(harness.app)

    expect(response.statusCode).toBe(201)
    const body = PlanMissionResultDtoSchema.parse(response.json())
    expect(body.missionId).toBe(NEW_MISSION)
    expect(body.file).toBe(NEW_MISSION_FILE)
    expect(body.plannerId).toBe(PLANNER_ID)
    expect(body.revisions).toBe(0)
    expect(body.report.ok).toBe(true)
    expect(body.report.stats.tasks).toBe(1)
    expect(body.rationale).toContain('uma task')

    // Gravado por NOS: o arquivo declara a versao do formato que o planejador nunca escolheu.
    const written = await readFile(join(harness.root, NEW_MISSION_FILE), 'utf8')
    expect(written).toContain('apiVersion: "agentic/v1"')
    expect(written).toContain('kind: "Mission"')

    // E o arquivo compila de verdade, pelo mesmo caminho de uma missao escrita a mao.
    const compiled = await harness.app.inject({
      method: 'GET',
      url: `/api/missions/${NEW_MISSION}/compile`,
    })
    expect(compiled.json<{ ok: boolean }>().ok).toBe(true)
  })

  it('depois do planejamento nenhum arquivo do repositorio mudou alem do artefato', async () => {
    harness = await createPlanningHarness({ steps: [{ plan: planOf() }] })
    expect(await harness.status()).toEqual([])

    const response = await planRequest(harness.app)
    expect(response.statusCode).toBe(201)

    expect(await harness.status()).toEqual([`?? ${NEW_MISSION_FILE}`])
  })

  it('o resultado do planejamento nunca nasce aprovado', async () => {
    harness = await createPlanningHarness({ steps: [{ plan: planOf() }] })
    const body = PlanMissionResultDtoSchema.parse((await planRequest(harness.app)).json())

    expect(body.run.status).toBe('DRAFT')
    expect(body.run.timestamps.approvedAt).toBeUndefined()

    const events = await harness.plane.persistence.events.list(body.run.id as RunId)
    expect(events.map((event) => event.type)).not.toContain('human.mission_approved')
    // Quem pediu o plano fica na linha do tempo: rascunho de agente tem autor humano.
    const note = events.find((event) => event.type === 'human.note_added')
    expect(note?.actor).toEqual({ kind: 'human', id: ACTOR })
  })

  it('plano invalido tenta correcao no maximo duas vezes e depois devolve ao humano', async () => {
    const invalid = { plan: planOf({ gate: 'nao-existe' }) }
    harness = await createPlanningHarness({
      steps: [
        invalid,
        { plan: planOf({ gate: 'tambem-nao', title: 'segunda tentativa' }) },
        { plan: planOf({ gate: 'nem-esse', title: 'terceira tentativa' }) },
      ],
    })
    const response = await planRequest(harness.app)

    expect(response.statusCode).toBe(422)
    const body = PlanningFailureDtoSchema.parse(response.json())
    expect(body.code).toBe('REVISIONS_EXHAUSTED')
    expect(body.revisions).toBe(2)
    expect(body.plannerId).toBe(PLANNER_ID)
    expect(body.problems.some((problem) => problem.message.includes('DA1007'))).toBe(true)

    // Uma proposta e DUAS correcoes: nunca uma terceira.
    expect(harness.planner.requests).toHaveLength(3)
    expect(harness.planner.requests.map((request) => request.revision?.attempt)).toEqual([
      undefined,
      1,
      2,
    ])
    // E nada foi gravado: nem arquivo, nem run.
    expect(await harness.status()).toEqual([])
    expect(await runsOf(harness)).toBe(0)
  })

  it('a correcao leva os problemas apontados e o plano que nos geramos', async () => {
    harness = await createPlanningHarness({
      steps: [{ plan: planOf({ gate: 'nao-existe' }) }, { plan: planOf() }],
    })
    const response = await planRequest(harness.app)

    expect(response.statusCode).toBe(201)
    expect(PlanMissionResultDtoSchema.parse(response.json()).revisions).toBe(1)

    const revision = harness.planner.requests[1]?.revision
    expect(revision?.attempt).toBe(1)
    expect(revision?.problems.some((problem) => problem.message.includes('nao-existe'))).toBe(true)
    // `previous` e o arquivo que o control plane montou, nao a saida crua do agente.
    expect(revision?.previous).toContain('apiVersion: "agentic/v1"')
  })

  it('plano semanticamente identico ao anterior interrompe o ciclo em vez de repetir', async () => {
    const same = { plan: planOf({ gate: 'nao-existe' }) }
    harness = await createPlanningHarness({ steps: [same, same, same] })
    const response = await planRequest(harness.app)

    expect(response.statusCode).toBe(422)
    expect(PlanningFailureDtoSchema.parse(response.json()).code).toBe('PLAN_UNCHANGED')
    // Parou na repeticao: a segunda correcao permitida nao chegou a ser gasta.
    expect(harness.planner.requests).toHaveLength(2)
  })

  it('arquivo de missao existente nunca e sobrescrito em silencio', async () => {
    const existente = 'apiVersion: agentic/v1\nkind: Mission\nid: DA-VELHA-001\n'
    harness = await createPlanningHarness({
      seeded: { 'DA-VELHA-001': existente },
      steps: [{ plan: planOf({ id: 'DA-VELHA-001' }) }, { plan: planOf() }],
    })
    const response = await planRequest(harness.app)

    expect(response.statusCode).toBe(201)
    const body = PlanMissionResultDtoSchema.parse(response.json())
    expect(body.missionId).toBe(NEW_MISSION)
    expect(body.revisions).toBe(1)

    // O arquivo de quem ja estava la continua byte a byte o mesmo.
    const path = join(harness.root, '.agentic', 'missions', 'DA-VELHA-001.mission.yaml')
    expect(await readFile(path, 'utf8')).toBe(existente)
    expect(await harness.status()).toEqual([`?? ${NEW_MISSION_FILE}`])

    // O id ocupado chegou ao planejador ANTES da primeira proposta, e a correcao explicou.
    expect(harness.planner.requests[0]?.context.takenMissionIds).toContain('DA-VELHA-001')
    expect(harness.planner.requests[1]?.revision?.problems[0]?.message).toContain('ja existe')
  })

  it('planejador que altera o repositorio faz o planejamento falhar sem gravar nada', async () => {
    harness = await createPlanningHarness({
      steps: [{ plan: planOf(), writes: { path: 'README.md', text: 'o agente escreveu aqui\n' } }],
    })
    const response = await planRequest(harness.app)

    expect(response.statusCode).toBe(422)
    const body = PlanningFailureDtoSchema.parse(response.json())
    expect(body.code).toBe('PLANNER_FAILED')
    expect(body.message).toContain('o repositorio mudou durante o planejamento')

    expect(await harness.status()).toEqual(['M README.md'])
    expect(await runsOf(harness)).toBe(0)
  })

  it('falha de planejamento e reportada com motivo, nao como plano vazio', async () => {
    harness = await createPlanningHarness({ steps: [{ failWith: 'PLANNER_UNAVAILABLE' }] })
    const response = await planRequest(harness.app)

    expect(response.statusCode).toBe(503)
    const body = PlanningFailureDtoSchema.parse(response.json())
    expect(body.code).toBe('PLANNER_UNAVAILABLE')
    expect(body.message.length).toBeGreaterThan(0)
    expect(body.revisions).toBe(0)

    // Falha de processo nao entra em ciclo de reparo: repetir so gastaria assinatura.
    expect(harness.planner.requests).toHaveLength(1)
    expect(await runsOf(harness)).toBe(0)
    expect(await harness.status()).toEqual([])
  })

  it('planejador que nao aceita correcao devolve a decisao ao humano na primeira recusa', async () => {
    harness = await createPlanningHarness({
      steps: [{ plan: planOf({ gate: 'nao-existe' }) }],
      capabilities: { acceptsRevision: false },
    })
    const response = await planRequest(harness.app)

    expect(response.statusCode).toBe(422)
    expect(PlanningFailureDtoSchema.parse(response.json()).code).toBe('REVISIONS_EXHAUSTED')
    expect(harness.planner.requests).toHaveLength(1)
  })
})

describe('recusas antes de acionar o planejador', () => {
  it('planejador real exige aceite explicito do consumo de assinatura', async () => {
    harness = await createPlanningHarness({
      steps: [{ plan: planOf() }],
      capabilities: { simulated: false },
    })
    const response = await planRequest(harness.app, { acceptsSubscriptionUse: false })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('COMMAND_REFUSED')
    expect(harness.planner.requests).toHaveLength(0)
  })

  it('planejador simulado nao exige aceite: nao ha assinatura para gastar', async () => {
    harness = await createPlanningHarness({ steps: [{ plan: planOf() }] })
    const response = await planRequest(harness.app, { acceptsSubscriptionUse: false })

    expect(response.statusCode).toBe(201)
  })

  it('pedido sem o aceite declarado nem chega ao control plane', async () => {
    harness = await createPlanningHarness({ steps: [{ plan: planOf() }] })
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/plan',
      payload: { prompt: 'faca alguma coisa', actor: ACTOR },
    })

    expect(response.statusCode).toBe(400)
    const error = response.json<{ error: { code: string; issues?: { path: string }[] } }>().error
    expect(error.code).toBe('PLAN_COMMAND_INVALID')
    expect(error.issues?.some((issue) => issue.path.includes('acceptsSubscriptionUse'))).toBe(true)
  })

  it('planejador desconhecido e recusado com a lista do que existe', async () => {
    harness = await createPlanningHarness({ steps: [{ plan: planOf() }] })
    const response = await planRequest(harness.app, { plannerId: 'nao-configurado' })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: { message: string } }>().error.message).toContain(PLANNER_ID)
    expect(harness.planner.requests).toHaveLength(0)
  })

  it('projeto sem planejador recusa em vez de fingir que planejou', async () => {
    harness = await createPlanningHarness({ steps: [{ plan: planOf() }], noPlanners: true })
    const response = await planRequest(harness.app)

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      'nenhum planejador',
    )
  })
})

describe('GET /api/planners', () => {
  it('diz quem planeja e se e simulacao, sem pintar de pronto o que nao foi apurado', async () => {
    harness = await createPlanningHarness({ steps: [{ plan: planOf() }] })
    const response = await harness.app.inject({ method: 'GET', url: '/api/planners' })

    expect(response.statusCode).toBe(200)
    const planners = response.json<unknown[]>().map((item) => PlannerDtoSchema.parse(item))
    expect(planners).toHaveLength(1)
    expect(planners[0]?.providerId).toBe(PLANNER_ID)
    expect(planners[0]?.simulated).toBe(true)
    expect(planners[0]?.state).toBe('UNKNOWN')
  })

  it('projeto sem planejador responde lista vazia, nao erro', async () => {
    harness = await createPlanningHarness({ steps: [], noPlanners: true })
    const response = await harness.app.inject({ method: 'GET', url: '/api/planners' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([])
  })
})
