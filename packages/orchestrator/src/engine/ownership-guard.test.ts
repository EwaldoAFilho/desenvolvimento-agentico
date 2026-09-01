import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileMission } from '@agentic/compiler'
import type { RunId } from '@agentic/domain'
import { acquireControlPlaneOwnership, type ControlPlaneLease } from '@agentic/persistence'
import { parseGatesFile, parseMissionFile, parseProjectFile, toMissionSpec } from '@agentic/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { GATE_ALWAYS_PASS, gatesYaml, missionYaml, projectYaml } from './__fixtures__/files.js'
import { type ControlPlane, createControlPlane } from './control-plane.js'

/**
 * I14, o lado que faltava: mutar NAO pode acontecer num plane que nao PROVOU posse.
 *
 * O guard anterior cobrava a posse so quando ela existia (`lease !== undefined && !held`).
 * Com isso, um plane construido sem lease — `mission approve` pelo caminho local, um
 * harness, uma composicao esquecida — mutava o `state.db` de um projeto que pertence a
 * OUTRO processo. Ausencia de posse nao e permissao: e recusa.
 */

const MISSION = missionYaml({ id: 'DA-OWN-001', tasks: [{ id: 'T01' }], defaultGate: 'unit' })
const PROJECT = projectYaml()
const GATES = gatesYaml({ unit: [GATE_ALWAYS_PASS] })

const RUN_INEXISTENTE = '01J0000000000000000000000A' as RunId

interface Cenario {
  readonly plane: ControlPlane
  readonly lease?: ControlPlaneLease
  readonly root: string
  cleanup(): Promise<void>
}

const abertos: Cenario[] = []

async function cenario(options: { readonly comPosse: boolean }): Promise<Cenario> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentic-posse-')))
  const baseDir = join(root, '.agentic')
  const project = parseProjectFile(PROJECT)
  if (!project.ok) throw new Error('fixture: project.yaml invalido')
  const gates = parseGatesFile(GATES)
  if (!gates.ok) throw new Error('fixture: gates.yaml invalido')

  let lease: ControlPlaneLease | undefined
  if (options.comPosse) {
    const outcome = acquireControlPlaneOwnership({ baseDir })
    if (!outcome.ok) throw new Error(`fixture: posse recusada (${outcome.detail})`)
    lease = outcome.lease
  }

  const plane = createControlPlane({
    project: project.value,
    gatesFile: gates.value,
    repoRoot: root,
    baseDir,
    ...(lease === undefined ? {} : { lease }),
  })
  const cenarioAberto: Cenario = {
    plane,
    ...(lease === undefined ? {} : { lease }),
    root,
    cleanup: async (): Promise<void> => {
      await plane.close().catch(() => undefined)
      lease?.release()
      await rm(root, { recursive: true, force: true })
    },
  }
  abertos.push(cenarioAberto)
  return cenarioAberto
}

function missaoCompilada(): { spec: ReturnType<typeof toMissionSpec>; compiled: never } {
  const parsed = parseMissionFile(MISSION)
  if (!parsed.ok) throw new Error('fixture: mission.yaml invalido')
  const result = compileMission({ missionText: MISSION, projectFile: PROJECT, gatesFile: GATES })
  if (result.graph === undefined) throw new Error('fixture: missao nao compilou')
  return { spec: toMissionSpec(parsed.value), compiled: result.graph as never }
}

afterEach(async () => {
  while (abertos.length > 0)
    await abertos
      .pop()
      ?.cleanup()
      .catch(() => undefined)
})

describe('plane sem posse declarada nao muta (I14)', () => {
  it('createRun e recusado', async () => {
    const { plane } = await cenario({ comPosse: false })
    const { spec, compiled } = missaoCompilada()
    await expect(
      plane.createRun({ mission: spec, compiled, missionText: MISSION }),
    ).rejects.toThrow(/sem posse do projeto/i)
  })

  it('approveMission e recusado', async () => {
    const { plane } = await cenario({ comPosse: false })
    await expect(
      plane.approveMission({ runId: RUN_INEXISTENTE, actor: 'humano@teste' }),
    ).rejects.toThrow(/sem posse do projeto/i)
  })

  it('startRun e recusado', async () => {
    const { plane } = await cenario({ comPosse: false })
    await expect(
      plane.startRun({ runId: RUN_INEXISTENTE, actor: 'humano@teste', acceptWarnings: true }),
    ).rejects.toThrow(/sem posse do projeto/i)
  })

  it('open (abrir orquestrador) e recusado', async () => {
    const { plane } = await cenario({ comPosse: false })
    await expect(plane.open(RUN_INEXISTENTE)).rejects.toThrow(/sem posse do projeto/i)
  })

  it('adoptRecoverableRuns continua recusado', async () => {
    const { plane } = await cenario({ comPosse: false })
    await expect(plane.adoptRecoverableRuns()).rejects.toThrow(/sem posse do projeto/i)
  })

  it('a persistencia publica tambem nao escreve: nao ha atalho por fora da fachada', async () => {
    const { plane } = await cenario({ comPosse: false })
    const { spec, compiled } = missaoCompilada()

    // `plane.createRun` recusar nao basta se `plane.persistence.runs.createRun` escrever: o
    // objeto e publico, e a invariante nao pode depender de ninguem lembrar de nao usa-lo.
    await expect(
      plane.persistence.runs.createRun({ id: RUN_INEXISTENTE } as never, []),
    ).rejects.toThrow(/sem posse do projeto/i)
    await expect(plane.persistence.runs.withTransaction(async () => undefined)).rejects.toThrow(
      /sem posse do projeto/i,
    )
    await expect(
      plane.persistence.events.append({ runId: RUN_INEXISTENTE } as never),
    ).rejects.toThrow(/sem posse do projeto/i)
    await expect(
      plane.persistence.artifacts.write({ runId: RUN_INEXISTENTE } as never),
    ).rejects.toThrow(/sem posse do projeto/i)

    // E a LEITURA continua inteira: e ela que sustenta status, report e inspect.
    expect(plane.persistence.queries.listRuns({ limit: 10 })).toEqual([])
    expect(await plane.persistence.runs.loadRun(RUN_INEXISTENTE)).toBeUndefined()
    expect(await plane.persistence.events.list(RUN_INEXISTENTE)).toEqual([])
    void spec
    void compiled
  })

  it('a recusa acontece ANTES de escrever: nenhum run entra no banco', async () => {
    const { plane } = await cenario({ comPosse: false })
    const { spec, compiled } = missaoCompilada()
    await plane.createRun({ mission: spec, compiled, missionText: MISSION }).catch(() => undefined)
    expect(plane.persistence.queries.listRuns({ limit: 10 })).toEqual([])
  })
})

describe('plane COM posse continua funcionando', () => {
  it('a persistencia volta a escrever quando ha posse', async () => {
    const { plane } = await cenario({ comPosse: true })
    const { spec, compiled } = missaoCompilada()
    const run = await plane.createRun({ mission: spec, compiled, missionText: MISSION })
    // Pela persistencia publica, com posse, a escrita passa: o espelho some junto com a
    // duvida sobre quem manda no projeto.
    await plane.persistence.events.append({
      runId: run.id,
      ts: new Date('2026-01-01T00:00:00.000Z'),
      type: 'run.created',
      actor: { kind: 'human', id: 'teste' },
      payload: {},
    } as never)
    expect((await plane.persistence.events.list(run.id)).length).toBeGreaterThan(0)
  })

  it('createRun e approveMission operam normalmente', async () => {
    const { plane } = await cenario({ comPosse: true })
    const { spec, compiled } = missaoCompilada()
    const run = await plane.createRun({ mission: spec, compiled, missionText: MISSION })
    expect(run.status).toBe('DRAFT')
    const aprovado = await plane.approveMission({ runId: run.id, actor: 'humano@teste' })
    expect(aprovado.status).toBe('APPROVED')
  })

  it('posse SOLTA no meio do caminho volta a recusar', async () => {
    const cenarioAberto = await cenario({ comPosse: true })
    const { spec, compiled } = missaoCompilada()
    const run = await cenarioAberto.plane.createRun({
      mission: spec,
      compiled,
      missionText: MISSION,
    })
    cenarioAberto.lease?.release()
    await expect(
      cenarioAberto.plane.approveMission({ runId: run.id, actor: 'humano@teste' }),
    ).rejects.toThrow(/sem posse do projeto/i)
  })
})
