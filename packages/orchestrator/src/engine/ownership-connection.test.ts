import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileMission } from '@agentic/compiler'
import type { RunId } from '@agentic/domain'
import {
  acquireControlPlaneOwnership,
  type ControlPlaneLease,
  openPersistence,
  type SqliteDatabase,
} from '@agentic/persistence'
import { parseGatesFile, parseMissionFile, parseProjectFile, toMissionSpec } from '@agentic/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { GATE_ALWAYS_PASS, gatesYaml, missionYaml, projectYaml } from './__fixtures__/files.js'
import { type ControlPlane, createControlPlane } from './control-plane.js'

/**
 * A fronteira de mutacao e a CONEXAO, nao um espelho de JavaScript.
 *
 * 003B fechou os bypasses um a um — fachada, stores, handle cru — e a revisao seguinte
 * mostrou por que essa forma nao termina: uma funcao capturada antes do `release` continuava
 * escrevendo, e a reflexao alcancava o handle. Toda defesa que ESCONDE capacidade tem uma
 * proxima porta.
 *
 * Estes testes afirmam a PROPRIEDADE, nao o mecanismo: sem posse, nenhuma escrita persiste.
 * Nenhum deles conhece Proxy, allowlist ou nome de erro do guard — para que a implementacao
 * possa trocar sem que a prova precise ser reescrita.
 */

const MISSION = missionYaml({ id: 'DA-CONN-001', tasks: [{ id: 'T01' }], defaultGate: 'unit' })
const PROJECT = projectYaml()
const GATES = gatesYaml({ unit: [GATE_ALWAYS_PASS] })

const RUN_INEXISTENTE = '01J0000000000000000000000A' as RunId

interface Cenario {
  readonly plane: ControlPlane
  readonly lease?: ControlPlaneLease
  readonly root: string
  readonly runtimeDir: string
  cleanup(): Promise<void>
}

const abertos: Cenario[] = []

async function projetoVazio(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'agentic-conn-')))
}

function configBase(): { project: never; gatesFile: never } {
  const project = parseProjectFile(PROJECT)
  if (!project.ok) throw new Error('fixture: project.yaml invalido')
  const gates = parseGatesFile(GATES)
  if (!gates.ok) throw new Error('fixture: gates.yaml invalido')
  return { project: project.value as never, gatesFile: gates.value as never }
}

/**
 * Um projeto com `state.db` JA criado, porque um plane de leitura nao cria banco (Fase 10) e
 * quase todo teste daqui precisa de um banco existente para provar a recusa de ESCRITA — e
 * nao a ausencia do arquivo.
 */
async function comBancoCriado(root: string): Promise<void> {
  const posse = acquireControlPlaneOwnership({ baseDir: join(root, '.agentic') })
  if (!posse.ok) throw new Error(`fixture: posse recusada (${posse.detail})`)
  const plane = createControlPlane({ ...configBase(), repoRoot: root, lease: posse.lease })
  await plane.close()
  posse.lease.release()
}

async function cenario(options: {
  readonly comPosse: boolean
  readonly root?: string
  readonly criarBanco?: boolean
}): Promise<Cenario> {
  const root = options.root ?? (await projetoVazio())
  const runtimeDir = join(root, '.agentic')
  if (options.criarBanco !== false && !options.comPosse) await comBancoCriado(root)

  let lease: ControlPlaneLease | undefined
  if (options.comPosse) {
    const outcome = acquireControlPlaneOwnership({ baseDir: runtimeDir })
    if (!outcome.ok) throw new Error(`fixture: posse recusada (${outcome.detail})`)
    lease = outcome.lease
  }

  const plane = createControlPlane({
    ...configBase(),
    repoRoot: root,
    ...(lease === undefined ? {} : { lease }),
  })
  const aberto: Cenario = {
    plane,
    ...(lease === undefined ? {} : { lease }),
    root,
    runtimeDir,
    cleanup: async (): Promise<void> => {
      await plane.close().catch(() => undefined)
      lease?.release()
      await rm(root, { recursive: true, force: true })
    },
  }
  abertos.push(aberto)
  return aberto
}

function missaoCompilada(): { spec: ReturnType<typeof toMissionSpec>; compiled: never } {
  const parsed = parseMissionFile(MISSION)
  if (!parsed.ok) throw new Error('fixture: mission.yaml invalido')
  const result = compileMission({ missionText: MISSION, projectFile: PROJECT, gatesFile: GATES })
  if (result.graph === undefined) throw new Error('fixture: missao nao compilou')
  return { spec: toMissionSpec(parsed.value), compiled: result.graph as never }
}

/** Quantos runs o banco REALMENTE tem, lido por uma conexao independente deste plane. */
function runsNoDisco(runtimeDir: string): number {
  const frio = openPersistence({ baseDir: runtimeDir, mode: 'readonly' })
  try {
    return frio.queries.listRuns({ limit: 100 }).length
  } finally {
    frio.close()
  }
}

afterEach(async () => {
  while (abertos.length > 0)
    await abertos
      .pop()
      ?.cleanup()
      .catch(() => undefined)
})

describe('A. capacidade capturada nao sobrevive a posse', () => {
  it('funcao guardada ANTES do release nao escreve depois dele', async () => {
    const aberto = await cenario({ comPosse: true })
    const { spec, compiled } = missaoCompilada()
    const run = await aberto.plane.createRun({ mission: spec, compiled, missionText: MISSION })

    // O ataque do reviewer: guardar a capacidade enquanto ela e legitima.
    const append = aberto.plane.persistence.events.append.bind(aberto.plane.persistence.events)
    const antes = await aberto.plane.persistence.events.list(run.id)

    aberto.lease?.release()

    await expect(
      append({
        runId: run.id,
        ts: new Date('2026-01-01T00:00:00.000Z'),
        type: 'run.created',
        actor: { kind: 'human', id: 'capturado' },
        payload: {},
      } as never),
    ).rejects.toThrow()

    // A prova nao e a excecao: e o disco. Nenhum evento novo entrou.
    const frio = await cenario({ comPosse: false, root: aberto.root, criarBanco: false })
    expect((await frio.plane.persistence.events.list(run.id)).length).toBe(antes.length)
  })

  it('transacao capturada antes do release tambem nao escreve', async () => {
    const aberto = await cenario({ comPosse: true })
    const { spec, compiled } = missaoCompilada()
    await aberto.plane.createRun({ mission: spec, compiled, missionText: MISSION })
    const store = aberto.plane.persistence.runs
    const withTransaction = store.withTransaction.bind(store)

    aberto.lease?.release()

    await expect(withTransaction(async () => undefined)).rejects.toThrow()
    expect(runsNoDisco(aberto.runtimeDir)).toBe(1)
  })
})

describe('B. reflexao nao produz escritor', () => {
  it('o handle alcancado por qualquer porta esta em conexao readonly', async () => {
    const aberto = await cenario({ comPosse: false })

    // Cinco portas para o MESMO handle. Nao exigimos que estejam fechadas — exigimos que o
    // que sai delas seja incapaz de escrever, que e a propriedade que interessa.
    const portas: (() => SqliteDatabase | undefined)[] = [
      () => aberto.plane.persistence.database.db,
      () => aberto.plane.persistence.runs.db,
      () => aberto.plane.persistence.events.db,
      () => aberto.plane.persistence.artifacts.db,
      () => aberto.plane.persistence.queries.db,
    ]

    for (const porta of portas) {
      let db: SqliteDatabase | undefined
      try {
        db = porta()
      } catch {
        continue // porta fechada tambem serve
      }
      if (db === undefined) continue
      expect(db.readonly).toBe(true)
      expect(() => db.prepare("UPDATE runs SET status = 'DONE'").run()).toThrow()
      expect(() => db.exec('CREATE TABLE invasor (x INTEGER)')).toThrow()
      expect(() => db.exec('DELETE FROM runs')).toThrow()
    }
  })

  it('descriptor e Reflect nao entregam capacidade que o acesso normal nega', async () => {
    const aberto = await cenario({ comPosse: false })
    const alvo = aberto.plane.persistence.events as unknown as object

    const descriptor = Object.getOwnPropertyDescriptor(alvo, 'append')
    const viaReflect = Reflect.get(alvo, 'append') as
      | ((input: unknown) => Promise<unknown>)
      | undefined
    const candidatos = [descriptor?.value, viaReflect].filter(
      (fn): fn is (input: unknown) => Promise<unknown> => typeof fn === 'function',
    )

    for (const append of candidatos) {
      await expect(
        Promise.resolve(
          append.call(alvo, {
            runId: RUN_INEXISTENTE,
            ts: new Date(),
            type: 'run.created',
            actor: { kind: 'human', id: 'reflexao' },
            payload: {},
          }),
        ),
      ).rejects.toThrow()
    }
    expect(runsNoDisco(aberto.runtimeDir)).toBe(0)
  })
})

describe('C. a identidade sai do repoRoot, nunca do chamador', () => {
  it('baseDir do chamador e ignorado: o banco mora em <repoRoot>/.agentic', async () => {
    const repo = await projetoVazio()
    const alheio = await projetoVazio()
    const posse = acquireControlPlaneOwnership({ baseDir: join(repo, '.agentic') })
    if (!posse.ok) throw new Error('fixture: posse recusada')

    // `baseDir` nao existe mais no contrato; passa-lo nao pode mover nada.
    const plane = createControlPlane({
      ...configBase(),
      repoRoot: repo,
      lease: posse.lease,
      ...({ baseDir: join(alheio, '.agentic') } as Record<string, unknown>),
    })
    const { spec, compiled } = missaoCompilada()
    await plane.createRun({ mission: spec, compiled, missionText: MISSION })
    await plane.close()
    posse.lease.release()

    expect(existsSync(join(repo, '.agentic', 'state.db'))).toBe(true)
    expect(existsSync(join(alheio, '.agentic', 'state.db'))).toBe(false)
    await rm(repo, { recursive: true, force: true })
    await rm(alheio, { recursive: true, force: true })
  })

  it('lease do projeto A nao abre plane mutavel sobre o projeto B', async () => {
    const a = await projetoVazio()
    const b = await projetoVazio()
    const posseA = acquireControlPlaneOwnership({ baseDir: join(a, '.agentic') })
    if (!posseA.ok) throw new Error('fixture: posse recusada')

    expect(() =>
      createControlPlane({ ...configBase(), repoRoot: b, lease: posseA.lease }),
    ).toThrow(/nao autoriza operar/i)

    posseA.lease.release()
    expect(existsSync(join(b, '.agentic', 'state.db'))).toBe(false)
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  })
})

describe('D. databasePath nao e escape de posse', () => {
  it('databasePath do chamador nao move o banco mutavel para fora da posse', async () => {
    const repo = await projetoVazio()
    const alheio = await projetoVazio()
    const posse = acquireControlPlaneOwnership({ baseDir: join(repo, '.agentic') })
    if (!posse.ok) throw new Error('fixture: posse recusada')

    const plane = createControlPlane({
      ...configBase(),
      repoRoot: repo,
      lease: posse.lease,
      ...({ databasePath: join(alheio, 'roubado.db') } as Record<string, unknown>),
    })
    const { spec, compiled } = missaoCompilada()
    await plane.createRun({ mission: spec, compiled, missionText: MISSION })
    await plane.close()
    posse.lease.release()

    expect(existsSync(join(repo, '.agentic', 'state.db'))).toBe(true)
    expect(existsSync(join(alheio, 'roubado.db'))).toBe(false)
    await rm(repo, { recursive: true, force: true })
    await rm(alheio, { recursive: true, force: true })
  })
})

describe('a propriedade central: sem posse, nada persiste', () => {
  it('nenhum caminho de escrita deixa rastro no banco', async () => {
    const aberto = await cenario({ comPosse: false })
    const { spec, compiled } = missaoCompilada()

    const tentativas: (() => Promise<unknown>)[] = [
      () => aberto.plane.createRun({ mission: spec, compiled, missionText: MISSION }),
      () => aberto.plane.approveMission({ runId: RUN_INEXISTENTE, actor: 'a' }),
      () => aberto.plane.startRun({ runId: RUN_INEXISTENTE, actor: 'a', acceptWarnings: true }),
      () => aberto.plane.open(RUN_INEXISTENTE),
      () => aberto.plane.adoptRecoverableRuns(),
      () => aberto.plane.persistence.runs.createRun({ id: RUN_INEXISTENTE } as never, []),
      () => aberto.plane.persistence.runs.withTransaction(async () => undefined),
      () => aberto.plane.persistence.runs.commit(async () => undefined),
      () => aberto.plane.persistence.runs.withRecoveryTransaction(async () => undefined),
      () => aberto.plane.persistence.events.append({ runId: RUN_INEXISTENTE } as never),
      () => aberto.plane.persistence.artifacts.write({ runId: RUN_INEXISTENTE } as never),
    ]

    for (const tentativa of tentativas) {
      await expect(Promise.resolve().then(tentativa)).rejects.toThrow()
    }
    expect(runsNoDisco(aberto.runtimeDir)).toBe(0)
  })

  it('a LEITURA continua inteira sem posse: e ela que sustenta status e report', async () => {
    const aberto = await cenario({ comPosse: false })
    expect(aberto.plane.persistence.queries.listRuns({ limit: 10 })).toEqual([])
    expect(await aberto.plane.persistence.runs.loadRun(RUN_INEXISTENTE)).toBeUndefined()
    expect(await aberto.plane.persistence.events.list(RUN_INEXISTENTE)).toEqual([])
    expect(await aberto.plane.persistence.runs.listRuns()).toEqual([])
    expect(await aberto.plane.persistence.runs.loadTaskRuns(RUN_INEXISTENTE)).toEqual([])
    expect(await aberto.plane.persistence.runs.loadAttempts(RUN_INEXISTENTE)).toEqual([])
    expect(aberto.plane.persistence.artifacts.list(RUN_INEXISTENTE)).toEqual([])
    expect(aberto.plane.persistence.events.latestSeq()).toBe(0)
  })
})

describe('projeto novo: leitura nao cria banco', () => {
  it('plane de leitura em repo sem state.db recusa, e nao deixa arquivo atras', async () => {
    const root = await projetoVazio()
    expect(() => createControlPlane({ ...configBase(), repoRoot: root })).toThrow(
      /nao inicializado|not initialized/i,
    )
    expect(existsSync(join(root, '.agentic', 'state.db'))).toBe(false)
    await rm(root, { recursive: true, force: true })
  })
})
