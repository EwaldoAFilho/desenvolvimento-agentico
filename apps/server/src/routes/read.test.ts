import type { ProviderRegistry } from '@agentic/domain'
import { providerId as toProviderId } from '@agentic/domain'
import {
  EventDtoSchema,
  ProviderHealthDtoSchema,
  RunHeaderSchema,
  RunSnapshotSchema,
  TaskDetailSchema,
} from '@agentic/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { CLEAN_MISSION } from '../__fixtures__/files.js'
import { ACTOR, createServerHarness, type ServerHarness } from '../__fixtures__/harness.js'

let harness: ServerHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

/** Aprova e inicia pela API — o mesmo caminho do dashboard. */
async function startMission(active: ServerHarness, missionId = 'DA-SRV-001'): Promise<string> {
  const file = active.missionFile(missionId)
  const approved = await active.app.inject({
    method: 'POST',
    url: '/api/missions/approve',
    payload: { file, actor: ACTOR },
  })
  expect(approved.statusCode).toBe(200)
  const started = await active.app.inject({
    method: 'POST',
    url: '/api/runs',
    payload: { file, acceptWarnings: false, actor: ACTOR },
  })
  expect(started.statusCode).toBe(201)
  return started.json<{ runId: string }>().runId
}

describe('GET /api/health', () => {
  it('responde pelo proprio servidor, sem sondar agente nenhum', async () => {
    harness = await createServerHarness()
    const response = await harness.app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    const body = response.json<{ status: string; service: string; uptimeMs: number }>()
    expect(body.status).toBe('ok')
    expect(body.service).toBe('@agentic/server')
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0)
  })
})

describe('GET /api/runs', () => {
  it('sem run algum devolve lista vazia', async () => {
    harness = await createServerHarness()
    const response = await harness.app.inject({ method: 'GET', url: '/api/runs' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([])
  })

  it('lista o run no contrato de RunHeaderDto', async () => {
    harness = await createServerHarness()
    const runId = await startMission(harness)
    const response = await harness.app.inject({ method: 'GET', url: '/api/runs' })
    const runs = RunHeaderSchema.array().parse(response.json())
    expect(runs.map((run) => run.id)).toEqual([runId])
    expect(runs[0]?.missionId).toBe('DA-SRV-001')
    expect(runs[0]?.status).toBe('RUNNING')
  })
})

describe('GET /api/runs/:id/snapshot', () => {
  it('e coerente com o estado persistido depois de a missao avancar', async () => {
    harness = await createServerHarness({ missions: [CLEAN_MISSION] })
    const runId = await startMission(harness)
    await harness.drain(runId)

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/snapshot`,
    })
    expect(response.statusCode).toBe(200)
    const snapshot = RunSnapshotSchema.parse(response.json())

    const run = await harness.plane.persistence.runs.loadRun(runId as never)
    const tasks = await harness.plane.persistence.runs.loadTaskRuns(runId as never)
    expect(snapshot.run.status).toBe(run?.status)
    expect(snapshot.tasks.map((task) => [task.id, task.status])).toEqual(
      tasks.map((task) => [task.taskId, task.status]),
    )
    expect(snapshot.counters.DONE).toBe(tasks.filter((task) => task.status === 'DONE').length)
  })

  it('carrega a geometria congelada do grafo', async () => {
    harness = await createServerHarness()
    const runId = await startMission(harness)
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/snapshot`,
    })
    const snapshot = RunSnapshotSchema.parse(response.json())
    expect(snapshot.graph.nodes.map((node) => node.id)).toEqual(['T01', 'T02'])
    expect(snapshot.graph.edges).toEqual([{ from: 'T01', to: 'T02' }])
    expect(snapshot.graph.criticalPath).toEqual(['T01', 'T02'])
  })

  it('run inexistente responde 404', async () => {
    harness = await createServerHarness()
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/runs/01J0000000000000000000000A/snapshot',
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('RUN_NOT_FOUND')
  })

  it('id fora do formato tambem responde 404, nunca 500', async () => {
    harness = await createServerHarness()
    const response = await harness.app.inject({ method: 'GET', url: '/api/runs/nada/snapshot' })
    expect(response.statusCode).toBe(404)
  })
})

describe('GET /api/runs/:id/tasks/:taskId', () => {
  it('devolve o painel de detalhe no contrato', async () => {
    harness = await createServerHarness()
    const runId = await startMission(harness)
    await harness.drain(runId)
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/tasks/T01`,
    })
    expect(response.statusCode).toBe(200)
    const detail = TaskDetailSchema.parse(response.json())
    expect(detail.id).toBe('T01')
    expect(detail.graph.dependents).toEqual(['T02'])
    expect(detail.quality.gate).toBe('unit')
    expect(detail.events.length).toBeGreaterThan(0)
  })

  it('task inexistente no run responde 404', async () => {
    harness = await createServerHarness()
    const runId = await startMission(harness)
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/tasks/T99`,
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('GET /api/runs/:id/events', () => {
  it('devolve EventDto ordenado por seq e sem duplicata', async () => {
    harness = await createServerHarness()
    const runId = await startMission(harness)
    await harness.drain(runId)
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/events?since=0`,
    })
    const events = EventDtoSchema.array().parse(response.json())
    expect(events.length).toBeGreaterThan(3)
    const seqs = events.map((event) => event.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('`since` e exclusivo e `limit` corta a pagina', async () => {
    harness = await createServerHarness()
    const runId = await startMission(harness)
    await harness.drain(runId)
    const all = EventDtoSchema.array().parse(
      (await harness.app.inject({ method: 'GET', url: `/api/runs/${runId}/events` })).json(),
    )
    const first = all[0]
    expect(first).toBeDefined()
    const rest = EventDtoSchema.array().parse(
      (
        await harness.app.inject({
          method: 'GET',
          url: `/api/runs/${runId}/events?since=${first?.seq}&limit=2`,
        })
      ).json(),
    )
    expect(rest.length).toBe(2)
    expect(rest[0]?.seq).toBeGreaterThan(first?.seq ?? 0)
  })

  it('`since` invalido e recusado em vez de silenciado', async () => {
    harness = await createServerHarness()
    const runId = await startMission(harness)
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/events?since=abc`,
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('GET /api/providers', () => {
  it('preserva `unknown` como `unknown` no JSON — nunca vira boolean', async () => {
    const registry: ProviderRegistry = {
      get: () => {
        throw new Error('registry de teste nao despacha')
      },
      list: () => [toProviderId('mock')],
      health: () =>
        Promise.resolve([
          {
            providerId: toProviderId('mock'),
            installed: 'unknown',
            ready: 'unknown',
            version: 'unknown',
            detail: 'a CLI nao permite observar autenticacao',
            probedAt: new Date('2026-01-01T00:00:00.000Z'),
            running: 1,
            capacity: 3,
          },
        ]),
      capacity: () => ({
        global: { maxParallelTasks: 1, active: 0 },
        executor: { max: 1, active: 0 },
        reviewer: { max: 1, active: 0 },
        byProvider: { mock: { maxConcurrent: 4, running: 0 } },
      }),
    }
    harness = await createServerHarness({ registry })
    const response = await harness.app.inject({ method: 'GET', url: '/api/providers' })
    expect(response.statusCode).toBe(200)

    const raw = response.json<{ installed: unknown; ready: unknown }[]>()
    expect(raw[0]?.installed).toBe('unknown')
    expect(raw[0]?.ready).toBe('unknown')
    expect(typeof raw[0]?.ready).not.toBe('boolean')
    expect(response.payload).toContain('"ready":"unknown"')

    const parsed = ProviderHealthDtoSchema.array().parse(raw)
    expect(parsed[0]?.running).toBe(1)
    expect(parsed[0]?.capacity).toBe(3)
  })

  it('o provider mock real responde saude no contrato', async () => {
    harness = await createServerHarness()
    const response = await harness.app.inject({ method: 'GET', url: '/api/providers' })
    const parsed = ProviderHealthDtoSchema.array().parse(response.json())
    expect(parsed.map((item) => item.providerId)).toEqual(['mock'])
  })
})

describe('GET /api/runs/:id/report', () => {
  it('devolve o relatorio final medido', async () => {
    harness = await createServerHarness()
    const runId = await startMission(harness)
    await harness.drain(runId)
    const response = await harness.app.inject({ method: 'GET', url: `/api/runs/${runId}/report` })
    expect(response.statusCode).toBe(200)
    const report = response.json<{ runId: string; tasks: { total: number; done: number } }>()
    expect(report.runId).toBe(runId)
    expect(report.tasks.total).toBe(2)
    expect(report.tasks.done).toBe(2)
  })

  it('tambem entrega o relatorio em markdown', async () => {
    harness = await createServerHarness()
    const runId = await startMission(harness)
    await harness.drain(runId)
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/report?format=md`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/markdown')
    expect(response.payload).toContain('# Relatorio da missao DA-SRV-001')
  })

  it('relatorio de run inexistente responde 404', async () => {
    harness = await createServerHarness()
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/runs/01J0000000000000000000000A/report',
    })
    expect(response.statusCode).toBe(404)
  })
})
