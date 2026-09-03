import type { RunId } from '@agentic/domain'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLEAN_MISSION,
  ERROR_MISSION,
  FAILING_MISSION,
  GATE_ALWAYS_FAIL,
  GATE_ALWAYS_PASS,
  WARNING_MISSION,
} from '../__fixtures__/files.js'
import { ACTOR, createServerHarness, type ServerHarness } from '../__fixtures__/harness.js'

let harness: ServerHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

const ALL = { missions: [CLEAN_MISSION, WARNING_MISSION, ERROR_MISSION] }

async function approve(active: ServerHarness, missionId: string): Promise<void> {
  const response = await active.app.inject({
    method: 'POST',
    url: '/api/missions/approve',
    payload: { file: active.missionFile(missionId), actor: ACTOR },
  })
  expect(response.statusCode).toBe(200)
}

function start(
  active: ServerHarness,
  missionId: string,
  extra: Record<string, unknown> = {},
): Promise<{ statusCode: number; json: <T>() => T }> {
  return active.app.inject({
    method: 'POST',
    url: '/api/runs',
    payload: { file: active.missionFile(missionId), acceptWarnings: false, actor: ACTOR, ...extra },
  })
}

describe('POST /api/runs — START MISSION', () => {
  it('sem aprovacao humana nao parte', async () => {
    harness = await createServerHarness(ALL)
    const response = await start(harness, 'DA-SRV-001')
    expect(response.statusCode).toBe(400)
    const error = response.json<{ error: { code: string; message: string } }>().error
    expect(error.code).toBe('MISSION_NOT_APPROVED')
    expect(error.message).toContain('POST /api/missions/approve')
  })

  it('segundo START do mesmo spec diz que o run ja partiu, em vez de mandar aprovar', async () => {
    harness = await createServerHarness(ALL)
    await approve(harness, 'DA-SRV-001')
    const first = await start(harness, 'DA-SRV-001')
    expect(first.statusCode).toBe(201)
    const runId = first.json<{ runId: string }>().runId

    const second = await start(harness, 'DA-SRV-001')
    expect(second.statusCode).toBe(400)
    const error = second.json<{ error: { code: string; message: string } }>().error
    expect(error.message).toContain(runId)
    expect(error.message).toContain('RUNNING')
    // A recusa nao pode sugerir aprovar de novo sem dizer que isso cria OUTRO run.
    expect(error.message).toContain('NOVO run')
  })

  it('com diagnostico ERROR recusa e devolve a LISTA de erros', async () => {
    harness = await createServerHarness(ALL)
    const response = await start(harness, 'DA-SRV-003')
    expect(response.statusCode).toBe(400)
    const error = response.json<{ error: { code: string; diagnostics: { code: string }[] } }>()
      .error
    expect(error.code).toBe('MISSION_HAS_ERRORS')
    expect(error.diagnostics.map((item) => item.code)).toEqual(['DA1003'])
  })

  it('com WARNING pendente exige aceite explicito', async () => {
    harness = await createServerHarness(ALL)
    await approve(harness, 'DA-SRV-002')
    const response = await start(harness, 'DA-SRV-002')
    expect(response.statusCode).toBe(400)
    const error = response.json<{
      error: { code: string; message: string; diagnostics: { code: string }[] }
    }>().error
    expect(error.code).toBe('WARNINGS_NOT_ACCEPTED')
    expect(error.message).toContain('acceptWarnings')
    expect(error.diagnostics.map((item) => item.code)).toEqual(['DA2007'])
  })

  it('com o aceite explicito o run parte', async () => {
    harness = await createServerHarness(ALL)
    await approve(harness, 'DA-SRV-002')
    const response = await start(harness, 'DA-SRV-002', { acceptWarnings: true })
    expect(response.statusCode).toBe(201)
    const body = response.json<{ runId: string; run: { status: string } }>()
    expect(body.run.status).toBe('RUNNING')
    const run = await harness.plane.persistence.runs.loadRun(body.runId as RunId)
    expect(run?.status).toBe('RUNNING')
  })

  it('CONTROLE: missao aprovada e limpa parte sem aceite nenhum', async () => {
    harness = await createServerHarness(ALL)
    await approve(harness, 'DA-SRV-001')
    const response = await start(harness, 'DA-SRV-001')
    expect(response.statusCode).toBe(201)
    expect(response.json<{ run: { status: string } }>().run.status).toBe('RUNNING')
  })

  it('a partida e do plano inspecionado: specHash divergente recusa com MISSION_CHANGED', async () => {
    harness = await createServerHarness(ALL)
    await approve(harness, 'DA-SRV-001')
    const response = await start(harness, 'DA-SRV-001', {
      acceptWarnings: true,
      specHash: 'fnv1a64:0000000000000000',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('MISSION_CHANGED')
  })

  it('so com missionId a partida recompila o arquivo e parte no run APPROVED dessa versao', async () => {
    harness = await createServerHarness(ALL)
    await approve(harness, 'DA-SRV-001')
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { missionId: 'DA-SRV-001', acceptWarnings: true, actor: ACTOR },
    })
    expect(response.statusCode).toBe(201)
  })

  it('sem `actor` recusa: partir tambem e ato humano', async () => {
    harness = await createServerHarness(ALL)
    await approve(harness, 'DA-SRV-001')
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { file: harness.missionFile('DA-SRV-001'), acceptWarnings: false },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('START_COMMAND_INVALID')
  })

  it('sem referencia de missao recusa', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { acceptWarnings: true, actor: ACTOR },
    })
    expect(response.statusCode).toBe(400)
  })

  it('UM clique: o servidor pede o inicio do loop uma vez e nao despacha task a task', async () => {
    harness = await createServerHarness(ALL)
    await approve(harness, 'DA-SRV-001')
    const response = await start(harness, 'DA-SRV-001')
    const runId = response.json<{ runId: string }>().runId

    expect(harness.launched).toEqual([runId])
    // Nenhuma task saiu de PENDING por conta do servidor: quem descobre READY e o loop.
    const tasks = await harness.plane.persistence.runs.loadTaskRuns(runId as RunId)
    expect(tasks.map((task) => task.status)).toEqual(['PENDING', 'PENDING'])
  })

  it('com o launcher real a orquestracao anda ate concluir a missao', async () => {
    harness = await createServerHarness({ ...ALL, realLauncher: true })
    await approve(harness, 'DA-SRV-001')
    const response = await start(harness, 'DA-SRV-001')
    const runId = response.json<{ runId: string }>().runId
    await harness.drain(runId)
    const tasks = await harness.plane.persistence.runs.loadTaskRuns(runId as RunId)
    expect(tasks.map((task) => task.status)).toEqual(['DONE', 'DONE'])
  }, 60_000)
})

describe('comandos de run', () => {
  async function running(active: ServerHarness): Promise<string> {
    await approve(active, 'DA-SRV-001')
    const response = await start(active, 'DA-SRV-001')
    return response.json<{ runId: string }>().runId
  }

  it('pause leva o run a PAUSED', async () => {
    harness = await createServerHarness(ALL)
    const runId = await running(harness)
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/pause`,
      payload: { actor: ACTOR },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ status: string }>().status).toBe('PAUSED')
  })

  it('resume devolve o run a RUNNING', async () => {
    harness = await createServerHarness(ALL)
    const runId = await running(harness)
    await harness.app.inject({ method: 'POST', url: `/api/runs/${runId}/pause`, payload: {} })
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/resume`,
      payload: {},
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ status: string }>().status).toBe('RUNNING')
  })

  it('stop cancela o run inteiro', async () => {
    harness = await createServerHarness(ALL)
    const runId = await running(harness)
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/stop`,
      payload: { actor: ACTOR },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ status: string }>().status).toBe('CANCELLED')
  })

  it('comando em run inexistente responde 404', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/runs/01J0000000000000000000000A/pause',
      payload: {},
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('comandos de task', () => {
  async function started(active: ServerHarness): Promise<string> {
    await approve(active, 'DA-SRV-001')
    const response = await start(active, 'DA-SRV-001')
    return response.json<{ runId: string }>().runId
  }

  it('skip sem motivo e recusado', async () => {
    harness = await createServerHarness(ALL)
    const runId = await started(harness)
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tasks/T02/skip`,
      payload: { actor: ACTOR },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('SKIP_REQUIRES_REASON')
  })

  it('skip com motivo em branco tambem e recusado', async () => {
    harness = await createServerHarness(ALL)
    const runId = await started(harness)
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tasks/T02/skip`,
      payload: { actor: ACTOR, reason: '   ' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('skip com motivo pula a task e registra o motivo', async () => {
    harness = await createServerHarness(ALL)
    const runId = await started(harness)
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tasks/T02/skip`,
      payload: { actor: ACTOR, reason: 'coberta por outra entrega' },
    })
    expect(response.statusCode).toBe(200)
    const tasks = await harness.plane.persistence.runs.loadTaskRuns(runId as RunId)
    expect(tasks.find((task) => task.taskId === 'T02')?.status).toBe('SKIPPED')
    const events = await harness.plane.persistence.events.list(runId as RunId)
    const skipped = events.find((event) => event.type === 'human.task_skipped')
    expect((skipped?.payload as { reason?: string } | undefined)?.reason).toBe(
      'coberta por outra entrega',
    )
  })

  it('comando em task inexistente responde 404', async () => {
    harness = await createServerHarness(ALL)
    const runId = await started(harness)
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tasks/T77/skip`,
      payload: { actor: ACTOR, reason: 'qualquer' },
    })
    expect(response.statusCode).toBe(404)
  })

  it('unblock sem nota e recusado', async () => {
    harness = await createServerHarness(ALL)
    const runId = await started(harness)
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tasks/T01/unblock`,
      payload: { actor: ACTOR },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNBLOCK_REQUIRES_NOTE')
  })

  it('unblock com nota destrava a task parada e registra a decisao', async () => {
    harness = await createServerHarness({
      missions: [FAILING_MISSION],
      gates: { unit: [GATE_ALWAYS_PASS], flaky: [GATE_ALWAYS_FAIL] },
    })
    await approve(harness, 'DA-SRV-004')
    const response = await start(harness, 'DA-SRV-004')
    const runId = response.json<{ runId: string }>().runId
    await harness.drain(runId)

    const before = await harness.plane.persistence.runs.loadTaskRuns(runId as RunId)
    expect(before[0]?.status).toBe('BLOCKED')

    const unblocked = await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tasks/T01/unblock`,
      payload: { actor: ACTOR, note: 'ambiente corrigido na mao' },
    })
    expect(unblocked.statusCode).toBe(200)
    const events = await harness.plane.persistence.events.list(runId as RunId)
    const record = events.filter((event) => event.type === 'human.task_unblocked').at(-1)
    expect((record?.payload as { note?: string } | undefined)?.note).toBe(
      'ambiente corrigido na mao',
    )
    expect(record?.actor).toEqual({ kind: 'human', id: ACTOR })
    const after = await harness.plane.persistence.runs.loadTaskRuns(runId as RunId)
    expect(after[0]?.status).toBe('READY')
  }, 60_000)

  it('retry concede nova tentativa a uma task encerrada em falha', async () => {
    harness = await createServerHarness({
      missions: [FAILING_MISSION],
      gates: { unit: [GATE_ALWAYS_PASS], flaky: [GATE_ALWAYS_FAIL] },
    })
    await approve(harness, 'DA-SRV-004')
    const response = await start(harness, 'DA-SRV-004')
    const runId = response.json<{ runId: string }>().runId
    await harness.drain(runId)

    const retried = await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tasks/T01/retry`,
      payload: { actor: ACTOR },
    })
    expect(retried.statusCode).toBe(200)
    const events = await harness.plane.persistence.events.list(runId as RunId)
    expect(events.some((event) => event.type === 'human.task_unblocked')).toBe(true)
  }, 60_000)
})
