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
 * I14 pela FACHADA: mutar nao pode acontecer num plane que nao PROVOU posse.
 *
 * Este arquivo cobre a camada de cima — a recusa que o usuario LE. A camada de baixo, onde a
 * conexao readonly torna a escrita impossivel mesmo por referencia capturada ou reflexao,
 * vive em `ownership-connection.test.ts`. As duas provas sao diferentes de proposito:
 *
 * - a persistencia garante que NADA persiste sem posse (a invariante);
 * - a fachada garante que quem tenta recebe uma FRASE que explica o que fazer, em vez de um
 *   `SQLITE_READONLY` vazando do driver (o produto).
 *
 * Guardar so a segunda foi o erro da 003B: a mensagem certa nao e a barreira.
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

function arquivos(): { project: never; gatesFile: never } {
  const project = parseProjectFile(PROJECT)
  if (!project.ok) throw new Error('fixture: project.yaml invalido')
  const gates = parseGatesFile(GATES)
  if (!gates.ok) throw new Error('fixture: gates.yaml invalido')
  return { project: project.value as never, gatesFile: gates.value as never }
}

function possuir(root: string): ControlPlaneLease {
  const outcome = acquireControlPlaneOwnership({ baseDir: join(root, '.agentic') })
  if (!outcome.ok) throw new Error(`fixture: posse recusada (${outcome.detail})`)
  return outcome.lease
}

/**
 * Um plane de LEITURA precisa de banco: leitura nao inicializa projeto (Fase 10). O dono
 * temporario cria o `state.db` e devolve o projeto, que e exatamente o que `mission approve`
 * faz na producao.
 */
async function inicializar(root: string): Promise<void> {
  const lease = possuir(root)
  const plane = createControlPlane({ ...arquivos(), repoRoot: root, lease })
  await plane.close()
  lease.release()
}

async function cenario(options: { readonly comPosse: boolean }): Promise<Cenario> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentic-posse-')))
  if (!options.comPosse) await inicializar(root)
  const lease = options.comPosse ? possuir(root) : undefined

  const plane = createControlPlane({
    ...arquivos(),
    repoRoot: root,
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
  it('declara-se de LEITURA: a semantica nao e implicita', async () => {
    const { plane } = await cenario({ comPosse: false })
    expect(plane.access).toBe('readonly')
    expect(plane.persistence.mode).toBe('readonly')
    expect(plane.instanceId).toBeUndefined()
  })

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

  it('a recusa acontece ANTES de escrever: nenhum run entra no banco', async () => {
    const { plane } = await cenario({ comPosse: false })
    const { spec, compiled } = missaoCompilada()
    await plane.createRun({ mission: spec, compiled, missionText: MISSION }).catch(() => undefined)
    expect(plane.persistence.queries.listRuns({ limit: 10 })).toEqual([])
  })

  it('a LEITURA continua inteira: e ela que sustenta status, report e inspect', async () => {
    const { plane } = await cenario({ comPosse: false })
    expect(plane.persistence.queries.listRuns({ limit: 10 })).toEqual([])
    expect(await plane.persistence.runs.loadRun(RUN_INEXISTENTE)).toBeUndefined()
    expect(await plane.persistence.events.list(RUN_INEXISTENTE)).toEqual([])
    expect(plane.persistence.artifacts.list(RUN_INEXISTENTE)).toEqual([])
  })
})

describe('plane COM posse continua funcionando', () => {
  it('declara-se dono, e a conexao e mutavel', async () => {
    const { plane, lease } = await cenario({ comPosse: true })
    expect(plane.access).toBe('owned')
    expect(plane.persistence.mode).toBe('readwrite')
    expect(plane.instanceId).toBe(lease?.instanceId)
  })

  it('a persistencia escreve quando ha posse', async () => {
    const { plane } = await cenario({ comPosse: true })
    const { spec, compiled } = missaoCompilada()
    const run = await plane.createRun({ mission: spec, compiled, missionText: MISSION })
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

  it('lease de OUTRO projeto nao autoriza este: o plane nem chega a abrir', async () => {
    const dono = await cenario({ comPosse: true })
    const alheio = await realpath(await mkdtemp(join(tmpdir(), 'agentic-alheio-')))

    // Um lease legitimo — do projeto ERRADO. "Ter algum lease" nao prova posse deste
    // projeto, e sem esta conferencia o dono legitimo ganharia um segundo escritor.
    expect(() =>
      createControlPlane({
        ...arquivos(),
        repoRoot: alheio,
        lease: dono.lease as never,
      }),
    ).toThrow(/nao autoriza operar/i)
    await rm(alheio, { recursive: true, force: true })
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

  it('posse SOLTA fecha a conexao: nao ha plane meio-vivo sobre projeto alheio', async () => {
    const aberto = await cenario({ comPosse: true })
    const { spec, compiled } = missaoCompilada()
    await aberto.plane.createRun({ mission: spec, compiled, missionText: MISSION })

    aberto.lease?.release()

    /**
     * Depois do `release`, este plane nao le NEM escreve — e a leitura parar tambem e
     * deliberado, nao um efeito colateral aceito de mau grado.
     *
     * A 003B mantinha a leitura viva ("perder a posse tira o direito de escrever, nao o de
     * olhar"), e para isso a conexao mutavel tinha de continuar aberta: era exatamente ela
     * que a funcao capturada reencontrava. Ou a conexao fecha junto com a posse, ou a
     * capacidade sobrevive a ela; nao da para ter as duas.
     *
     * O custo e nenhum na producao, porque a ordem ja e essa: `withPlane` fecha o plane no
     * `finally` ANTES do `release`, e `shutdownControlPlane` para os efeitos antes de
     * devolver o projeto. Quem quiser ler depois abre um plane de leitura — que e mais
     * honesto, porque a essa altura o dono do banco pode ser outro processo.
     */
    expect(() => aberto.plane.persistence.runs.loadRun(RUN_INEXISTENTE)).toThrow(
      /connection is not open/i,
    )
    expect(() => aberto.plane.persistence.queries.listRuns({ limit: 1 })).toThrow(
      /connection is not open/i,
    )
  })
})
