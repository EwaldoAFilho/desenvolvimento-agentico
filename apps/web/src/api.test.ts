import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePlanFailure, makePlanResult, REAL_PLANNER } from './__fixtures__/planning.js'
import { makeSnapshot } from './__fixtures__/snapshot.js'
import {
  ApiError,
  approveMission,
  getPlanners,
  getRunSnapshot,
  planMission,
  planningFailureOf,
  skipTask,
  startRun,
  streamUrl,
  unblockTask,
} from './api.js'

interface Call {
  readonly url: string
  readonly method: string
  readonly body: unknown
}

function stubFetch(payload: unknown, ok = true, status = 200): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return {
      ok,
      status,
      statusText: 'erro',
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cliente da API', () => {
  it('o stream pede a partir do ultimo seq visto', () => {
    expect(streamUrl('run-1', 501)).toBe('/api/runs/run-1/stream?since=501')
  })

  it('valida o snapshot pelo schema do contrato', async () => {
    const calls = stubFetch(makeSnapshot())
    const snapshot = await getRunSnapshot('run-1')
    expect(snapshot.tasks).toHaveLength(17)
    expect(calls[0]?.url).toBe('/api/runs/run-1/snapshot')
  })

  it('recusa resposta fora do contrato em vez de renderizar lixo', async () => {
    stubFetch({ run: { id: 'x' } })
    await expect(getRunSnapshot('run-1')).rejects.toThrow()
  })

  it('aprovar envia o actor no corpo do comando', async () => {
    const calls = stubFetch({})
    await approveMission('DA-BPM-021', { actor: 'ewaldo', note: 'revisei os avisos' })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('/api/missions/DA-BPM-021/approve')
    expect(calls[0]?.body).toEqual({ actor: 'ewaldo', note: 'revisei os avisos' })
  })

  it('aprovar sem actor e recusado no cliente', async () => {
    stubFetch({})
    await expect(approveMission('DA-BPM-021', { actor: '' })).rejects.toThrow()
  })

  it('START MISSION exige aceite explicito de warnings no comando', async () => {
    const calls = stubFetch({ runId: 'run-9' })
    const runId = await startRun({ missionId: 'DA-BPM-021', acceptWarnings: true, actor: 'ewaldo' })
    expect(runId).toBe('run-9')
    expect(calls[0]?.url).toBe('/api/runs')
    expect(calls[0]?.body).toEqual({
      missionId: 'DA-BPM-021',
      acceptWarnings: true,
      actor: 'ewaldo',
    })
  })

  it('unblock sem nota e skip sem motivo nao saem do cliente', async () => {
    stubFetch({})
    await expect(unblockTask('run-1', { taskId: 'T14', note: '' })).rejects.toThrow()
    await expect(skipTask('run-1', { taskId: 'T14', reason: '' })).rejects.toThrow()
  })

  it('unblock e skip vao para o endpoint da task', async () => {
    const calls = stubFetch({})
    await unblockTask('run-1', { taskId: 'T14', note: 'decidido na ADR' })
    await skipTask('run-1', { taskId: 'T13', reason: 'fora do MVP' })
    expect(calls[0]?.url).toBe('/api/runs/run-1/tasks/T14/unblock')
    expect(calls[1]?.url).toBe('/api/runs/run-1/tasks/T13/skip')
  })

  it('erro HTTP vira ApiError com status', async () => {
    stubFetch({ message: 'missao nao aprovada' }, false, 409)
    await expect(getRunSnapshot('run-1')).rejects.toBeInstanceOf(ApiError)
  })
})

describe('planejamento pela API', () => {
  it('quem planeja tem endereco proprio e e validado pelo contrato', async () => {
    const calls = stubFetch([REAL_PLANNER])
    const planners = await getPlanners()
    expect(calls[0]?.url).toBe('/api/planners')
    expect(planners[0]?.simulated).toBe(false)
  })

  it('planejador fora do contrato nao vira opcao na tela', async () => {
    stubFetch([{ providerId: 'agente-a' }])
    await expect(getPlanners()).rejects.toThrow()
  })

  it('planejar leva pedido, planejador, aceite e autor no corpo', async () => {
    const calls = stubFetch(makePlanResult(), true, 201)
    const outcome = await planMission({
      prompt: 'quero um relatorio de estoque por deposito',
      plannerId: 'agente-a',
      acceptsSubscriptionUse: true,
      actor: 'ewaldo',
    })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('/api/missions/plan')
    expect(calls[0]?.body).toEqual({
      prompt: 'quero um relatorio de estoque por deposito',
      plannerId: 'agente-a',
      acceptsSubscriptionUse: true,
      actor: 'ewaldo',
    })
    expect(outcome.kind).toBe('planned')
  })

  it('pedido vazio ou sem autor nao sai do cliente', async () => {
    stubFetch(makePlanResult(), true, 201)
    await expect(
      planMission({ prompt: '   ', acceptsSubscriptionUse: false, actor: 'ewaldo' }),
    ).rejects.toThrow()
    await expect(
      planMission({ prompt: 'algo', acceptsSubscriptionUse: false, actor: '' }),
    ).rejects.toThrow()
  })

  it('422 com corpo de diagnostico vira recusa, nao excecao', async () => {
    stubFetch(makePlanFailure(), false, 422)
    const outcome = await planMission({
      prompt: 'quero um relatorio',
      acceptsSubscriptionUse: true,
      actor: 'ewaldo',
    })
    expect(outcome).toEqual({ kind: 'refused', failure: makePlanFailure() })
  })

  it('recusa de outra natureza continua sendo excecao — nao vira diagnostico de plano', async () => {
    stubFetch({ error: { code: 'PLANNING_UNAVAILABLE', message: 'sem planejamento' } }, false, 501)
    await expect(
      planMission({ prompt: 'quero um relatorio', acceptsSubscriptionUse: true, actor: 'ewaldo' }),
    ).rejects.toBeInstanceOf(ApiError)
  })

  it('so o corpo do contrato e lido como diagnostico de planejamento', () => {
    expect(planningFailureOf(new ApiError(422, JSON.stringify(makePlanFailure())))?.code).toBe(
      'CONTRACT_REJECTED',
    )
    expect(planningFailureOf(new ApiError(500, '<html>proxy</html>'))).toBeUndefined()
    expect(planningFailureOf(new ApiError(501, JSON.stringify({ error: { code: 'X' } })))).toBe(
      undefined,
    )
    expect(planningFailureOf(new Error('rede caiu'))).toBeUndefined()
  })
})
