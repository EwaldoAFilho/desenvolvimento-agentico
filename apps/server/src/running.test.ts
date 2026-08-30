import type { ProviderId, ProviderRegistry, RunId } from '@agentic/domain'
import { providerId as toProviderId } from '@agentic/domain'
import type { ProviderHealthDto } from '@agentic/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { CLEAN_MISSION } from './__fixtures__/files.js'
import {
  ACTOR,
  createServerHarness,
  type ServerHarness,
  seedInFlightAttempt,
} from './__fixtures__/harness.js'
import { applyPersistedRunning, EMPTY_TALLY, inFlightAgents, tallyOf } from './running.js'

let harness: ServerHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

/** Registry que MENTE `running`: e exatamente o que um livro-caixa de outro processo faz. */
function lyingRegistry(running: number, ids: readonly string[] = ['mock']): ProviderRegistry {
  return {
    get: () => {
      throw new Error('registry de teste nao despacha')
    },
    list: () => ids.map((id) => toProviderId(id)),
    health: () =>
      Promise.resolve(
        ids.map((id) => ({
          providerId: toProviderId(id),
          installed: true as const,
          ready: 'unknown' as const,
          version: '1.0.0',
          detail: 'sonda de teste',
          probedAt: new Date('2026-01-01T00:00:00.000Z'),
          running,
          capacity: 4,
        })),
      ),
    capacity: () => ({
      global: { maxParallelTasks: 4, active: 0 },
      executor: { max: 4, active: 0 },
      reviewer: { max: 4, active: 0 },
      byProvider: {},
    }),
  }
}

async function startRun(active: ServerHarness): Promise<string> {
  const approve = await active.app.inject({
    method: 'POST',
    url: '/api/missions/approve',
    payload: { file: active.missionFile('DA-SRV-001'), actor: ACTOR },
  })
  expect(approve.statusCode).toBe(200)
  const response = await active.app.inject({
    method: 'POST',
    url: '/api/runs',
    payload: { file: active.missionFile('DA-SRV-001'), acceptWarnings: false, actor: ACTOR },
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ runId: string }>().runId
}

function runningOf(payload: readonly ProviderHealthDto[], provider = 'mock'): number | undefined {
  return payload.find((entry) => entry.providerId === provider)?.running
}

describe('running derivado do estado persistido', () => {
  it('CONTROLE: sem tentativa em voo o numero e zero, mesmo com o registry dizendo 3', async () => {
    harness = await createServerHarness({
      missions: [CLEAN_MISSION],
      registry: lyingRegistry(3),
    })
    await startRun(harness)
    const response = await harness.app.inject({ method: 'GET', url: '/api/providers' })

    expect(response.statusCode).toBe(200)
    expect(runningOf(response.json<ProviderHealthDto[]>())).toBe(0)
  })

  it('uma tentativa RUNNING no banco vira running 1', async () => {
    harness = await createServerHarness({ missions: [CLEAN_MISSION], registry: lyingRegistry(0) })
    const runId = await startRun(harness)
    await seedInFlightAttempt(harness, runId, { taskId: 'T01', providerId: 'mock' })

    const response = await harness.app.inject({ method: 'GET', url: '/api/providers' })
    expect(runningOf(response.json<ProviderHealthDto[]>())).toBe(1)
  })

  it('DUAS tasks em RUNNING somam 2 — o caso real que saia como EM USO 0', async () => {
    harness = await createServerHarness({ missions: [CLEAN_MISSION], registry: lyingRegistry(0) })
    const runId = await startRun(harness)
    await seedInFlightAttempt(harness, runId, { taskId: 'T01', providerId: 'mock' })
    await seedInFlightAttempt(harness, runId, { taskId: 'T02', providerId: 'mock' })

    const response = await harness.app.inject({ method: 'GET', url: '/api/providers' })
    expect(runningOf(response.json<ProviderHealthDto[]>())).toBe(2)
  })

  it('task em REVIEW debita o fornecedor do REVISOR, nao o do executor', async () => {
    harness = await createServerHarness({
      missions: [CLEAN_MISSION],
      project: {
        providers: [
          { id: 'mock', maxConcurrent: 4 },
          { id: 'outro', maxConcurrent: 4 },
        ],
      },
      registry: lyingRegistry(0, ['mock', 'outro']),
    })
    const runId = await startRun(harness)
    await seedInFlightAttempt(harness, runId, {
      taskId: 'T01',
      providerId: 'mock',
      status: 'REVIEW',
      reviewerProviderId: 'outro',
    })

    const payload = (await harness.app.inject({ method: 'GET', url: '/api/providers' })).json<
      ProviderHealthDto[]
    >()
    expect(runningOf(payload, 'outro')).toBe(1)
    expect(runningOf(payload, 'mock')).toBe(0)
  })

  it('tentativa ja encerrada nao conta, mesmo com a task marcada RUNNING', async () => {
    harness = await createServerHarness({ missions: [CLEAN_MISSION], registry: lyingRegistry(0) })
    const runId = await startRun(harness)
    await seedInFlightAttempt(harness, runId, {
      taskId: 'T01',
      providerId: 'mock',
      finished: true,
    })

    const response = await harness.app.inject({ method: 'GET', url: '/api/providers' })
    expect(runningOf(response.json<ProviderHealthDto[]>())).toBe(0)
  })

  it('o snapshot mostra o MESMO numero que /api/providers', async () => {
    harness = await createServerHarness({ missions: [CLEAN_MISSION], registry: lyingRegistry(9) })
    const runId = await startRun(harness)
    await seedInFlightAttempt(harness, runId, { taskId: 'T01', providerId: 'mock' })

    const snapshot = (
      await harness.app.inject({ method: 'GET', url: `/api/runs/${runId}/snapshot` })
    ).json<{ providers: ProviderHealthDto[] }>()
    const providers = (await harness.app.inject({ method: 'GET', url: '/api/providers' })).json<
      ProviderHealthDto[]
    >()

    expect(runningOf(snapshot.providers)).toBe(1)
    expect(runningOf(snapshot.providers)).toBe(runningOf(providers))
  })

  it('run cancelado deixa de contar: run terminal nao tem agente em voo', async () => {
    harness = await createServerHarness({ missions: [CLEAN_MISSION], registry: lyingRegistry(0) })
    const runId = await startRun(harness)
    await seedInFlightAttempt(harness, runId, { taskId: 'T01', providerId: 'mock' })
    expect(await inFlightAgents(harness.plane.persistence)).toHaveLength(1)

    await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/stop`,
      payload: { actor: ACTOR },
    })
    expect(await inFlightAgents(harness.plane.persistence)).toHaveLength(0)
  })

  it('o agente em voo carrega run, task, tentativa, fornecedor e papel', async () => {
    harness = await createServerHarness({ missions: [CLEAN_MISSION], registry: lyingRegistry(0) })
    const runId = await startRun(harness)
    await seedInFlightAttempt(harness, runId, { taskId: 'T01', providerId: 'mock' })

    const agents = await inFlightAgents(harness.plane.persistence)
    expect(agents[0]).toMatchObject({
      runId: runId as RunId,
      taskId: 'T01',
      providerId: 'mock',
      slot: 'executor',
    })
  })
})

describe('tallyOf e applyPersistedRunning', () => {
  const provider = (id: string): ProviderId => toProviderId(id)

  it('agrega por fornecedor', () => {
    const agents = [
      {
        runId: 'r' as RunId,
        taskId: 'T01' as never,
        attemptId: 'a1' as never,
        providerId: provider('a'),
        slot: 'executor' as const,
      },
      {
        runId: 'r' as RunId,
        taskId: 'T02' as never,
        attemptId: 'a2' as never,
        providerId: provider('a'),
        slot: 'reviewer' as const,
      },
      {
        runId: 'r' as RunId,
        taskId: 'T03' as never,
        attemptId: 'a3' as never,
        providerId: provider('b'),
        slot: 'executor' as const,
      },
    ]
    expect(tallyOf(agents)).toEqual({ a: 2, b: 1 })
  })

  it('fornecedor sem entrada recebe zero explicito', () => {
    const health: ProviderHealthDto[] = [
      {
        providerId: provider('mock'),
        installed: 'unknown',
        ready: 'unknown',
        version: 'unknown',
        detail: 'sonda inconclusiva',
        running: 7,
        capacity: 2,
      },
    ]
    const applied = applyPersistedRunning(health, EMPTY_TALLY)
    expect(applied[0]?.running).toBe(0)
  })

  it('nao mexe em nenhum outro campo — `unknown` continua `unknown`', () => {
    const health: ProviderHealthDto[] = [
      {
        providerId: provider('mock'),
        installed: 'unknown',
        ready: 'unknown',
        version: 'unknown',
        detail: 'sonda inconclusiva',
        running: 7,
        capacity: null,
        readinessSource: 'nao apurada',
      },
    ]
    const applied = applyPersistedRunning(health, { byProvider: { mock: 3 }, agents: [] })
    expect(applied[0]).toEqual({ ...health[0], running: 3 })
    expect(applied[0]?.ready).toBe('unknown')
    expect(applied[0]?.capacity).toBeNull()
  })
})
