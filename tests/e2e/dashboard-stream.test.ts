import type { EventDto, RunSnapshot } from '@agentic/schemas'
import { RunSnapshotSchema } from '@agentic/schemas'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MISSION_PATH } from './support/fixture.js'
import { ACTOR, createMissionHarness, type MissionHarness } from './support/harness.js'
import { createApp, type LiveStream, openStream } from './support/server.js'

/**
 * O dashboard em tempo real, sem navegador: uma assinatura SSE aberta antes do START
 * MISSION acompanha o run inteiro. O ponto que importa e o do item 24 — quando uma task
 * conclui, o DEPENDENTE acende READY pelo proprio stream, sem refetch do snapshot.
 */

let harness: MissionHarness
let app: FastifyInstance
let stream: LiveStream
let snapshotInicial: RunSnapshot
let snapshotFinal: RunSnapshot
/** Toda chamada HTTP do teste passa por aqui: da para provar o que NAO foi refetchado. */
const chamadas: string[] = []

async function pedir(
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ statusCode: number; body: unknown }> {
  chamadas.push(`${method} ${url}`)
  const response =
    payload === undefined
      ? await app.inject({ method, url })
      : await app.inject({ method, url, payload })
  return { statusCode: response.statusCode, body: response.json() as unknown }
}

/** Indice do primeiro evento que casa com tipo e task, dentro do que o stream entregou. */
function indiceDe(events: readonly EventDto[], type: string, taskId?: string): number {
  return events.findIndex((event) => event.type === type && event.taskId === taskId)
}

beforeAll(async () => {
  harness = await createMissionHarness()
  app = createApp(harness)

  const snapshot = await pedir('GET', `/api/runs/${harness.runId}/snapshot`)
  snapshotInicial = snapshot.body as RunSnapshot

  // A assinatura entra ANTES da partida: o dashboard abre a tela e depois clica.
  stream = await openStream(app, `/api/runs/${harness.runId}/stream?since=0`)

  const started = await pedir('POST', '/api/runs', {
    file: MISSION_PATH,
    actor: ACTOR,
    acceptWarnings: false,
  })
  expect(started.statusCode).toBe(201)

  await stream.waitFor(
    (events) => events.some((event) => event.type === 'run.completed'),
    'o run.completed chegar pelo stream',
    90_000,
  )
  stream.close()

  snapshotFinal = (await pedir('GET', `/api/runs/${harness.runId}/snapshot`)).body as RunSnapshot
}, 240_000)

afterAll(async () => {
  stream?.close()
  await app?.close().catch(() => undefined)
  await harness?.cleanup()
})

describe('snapshot inicial', () => {
  it('responde no contrato publico com o run ainda parado', () => {
    expect(RunSnapshotSchema.safeParse(snapshotInicial).success).toBe(true)
    expect(snapshotInicial.run.status).toBe('APPROVED')
    expect(snapshotInicial.counters.PENDING).toBe(8)
    expect(snapshotInicial.counters.DONE).toBe(0)
  })

  it('traz a estrutura do DAG vinda do CompiledGraph, ja congelada', () => {
    const graph = snapshotInicial.graph
    const compiled = harness.compiled
    expect(graph.nodes.map((node) => node.id)).toEqual(compiled.nodes.map((node) => node.task.id))
    expect(graph.edges).toHaveLength(compiled.edges.length)
    expect(graph.edges).toHaveLength(12)
    expect(graph.waves).toEqual(compiled.waves)
    expect(graph.criticalPath).toEqual(compiled.criticalPath.tasks)

    const t05 = graph.nodes.find((node) => node.id === 'T05')
    expect(t05?.dependencies).toEqual(['T01', 'T03'])
    expect(t05?.touches).toEqual(['src/reposicao.js'])
    expect(t05?.risk).toBe('high')
    expect(t05?.phase).toBe('feature')
  })
})

describe('stream do run', () => {
  it('entrega os eventos pela conexao aberta, do backlog ao fim do run', () => {
    expect(stream.statusCode).toBe(200)
    expect(stream.contentType).toContain('text/event-stream')
    const tipos = stream.events.map((event) => event.type)
    expect(tipos[0]).toBe('run.created')
    expect(tipos).toContain('human.mission_approved')
    expect(tipos).toContain('run.started')
    expect(tipos).toContain('task.dispatched')
    expect(tipos).toContain('gate.finished')
    expect(tipos).toContain('review.finished')
    expect(tipos).toContain('workspace.integrated')
    expect(tipos).toContain('run.completed')
  })

  it('numera cada frame com o seq do evento, sem lacuna nem duplicata', () => {
    const seqs = stream.events.map((event) => event.seq)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs[0]).toBe(1)
    expect(seqs[seqs.length - 1]).toBe(seqs.length)
    // O `id:` do frame SSE e o `seq`: e com ele que o cliente reconecta sem perder nada.
    expect(stream.ids).toEqual(seqs)
  })

  it('acende o dependente READY pelo proprio stream quando a dependencia conclui', () => {
    const doneT01 = indiceDe(stream.events, 'task.done', 'T01')
    const doneT02 = indiceDe(stream.events, 'task.done', 'T02')
    const readyT03 = indiceDe(stream.events, 'task.ready', 'T03')
    expect(doneT01).toBeGreaterThanOrEqual(0)
    expect(doneT02).toBeGreaterThanOrEqual(0)
    expect(readyT03).toBeGreaterThan(Math.max(doneT01, doneT02))

    const ready = stream.events[readyT03]
    expect(ready?.type).toBe('task.ready')
    expect(ready?.payload.unblockedBy).toEqual(['T01', 'T02'])
  })

  it('acende toda a cadeia sem nenhum refetch de snapshot no meio', () => {
    for (const taskId of ['T03', 'T04', 'T05', 'T06', 'T07', 'T08']) {
      expect(indiceDe(stream.events, 'task.ready', taskId), taskId).toBeGreaterThanOrEqual(0)
    }
    const snapshots = chamadas.filter((chamada) => chamada.includes('/snapshot'))
    expect(snapshots).toHaveLength(2)
    // Um snapshot antes da partida, um depois do fim. Entre os dois, so o stream.
    expect(chamadas).toEqual([
      `GET /api/runs/${harness.runId}/snapshot`,
      'POST /api/runs',
      `GET /api/runs/${harness.runId}/snapshot`,
    ])
  })
})

describe('snapshot final', () => {
  it('fecha o run com as oito tasks DONE e o mesmo DAG do inicio', () => {
    expect(snapshotFinal.run.status).toBe('COMPLETED')
    expect(snapshotFinal.counters.DONE).toBe(8)
    expect(snapshotFinal.graph.nodes).toEqual(snapshotInicial.graph.nodes)
    expect(snapshotFinal.graph.waves).toEqual(snapshotInicial.graph.waves)
    expect(snapshotFinal.metrics.attempts).toBe(8)
    expect(snapshotFinal.metrics.retries).toBe(0)
  })
})
