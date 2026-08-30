import type { RunId } from '@agentic/domain'
import { EventDtoSchema } from '@agentic/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { ACTOR, createServerHarness, type ServerHarness } from '../__fixtures__/harness.js'
import { captureStream, parseSse } from '../__fixtures__/sse-client.js'

let harness: ServerHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

async function runWithEvents(
  active: ServerHarness,
  drain = true,
): Promise<{ runId: string; seqs: number[] }> {
  const file = active.missionFile('DA-SRV-001')
  await active.app.inject({
    method: 'POST',
    url: '/api/missions/approve',
    payload: { file, actor: ACTOR },
  })
  const started = await active.app.inject({
    method: 'POST',
    url: '/api/runs',
    payload: { file, acceptWarnings: false, actor: ACTOR },
  })
  const runId = started.json<{ runId: string }>().runId
  if (drain) await active.drain(runId)
  const events = EventDtoSchema.array().parse(
    (await active.app.inject({ method: 'GET', url: `/api/runs/${runId}/events` })).json(),
  )
  return { runId, seqs: events.map((event) => event.seq) }
}

describe('parser SSE do teste', () => {
  it('separa evento nomeado, id e comentario', () => {
    const parsed = parseSse(': ping\n\nid: 7\nevent: event\ndata: {"seq":7}\n\nresto')
    expect(parsed.comments).toEqual(['ping'])
    expect(parsed.messages).toEqual([{ event: 'event', id: 7, data: '{"seq":7}' }])
    expect(parsed.rest).toBe('resto')
  })
})

describe('GET /api/runs/:id/stream', () => {
  it('abre com o content-type de SSE', async () => {
    harness = await createServerHarness()
    const { runId } = await runWithEvents(harness)
    const capture = await captureStream(harness.app, `/api/runs/${runId}/stream?since=0`, {
      events: 1,
    })
    expect(capture.statusCode).toBe(200)
    expect(capture.contentType).toContain('text/event-stream')
  })

  it('entrega o backlog a partir de `since` (exclusivo) e em ordem de seq', async () => {
    harness = await createServerHarness()
    const { runId, seqs } = await runWithEvents(harness)
    const capture = await captureStream(harness.app, `/api/runs/${runId}/stream?since=0`, {
      events: 5,
    })
    expect(capture.events.map((event) => event.seq)).toEqual(seqs.slice(0, 5))
  })

  it('`since` maior que zero nao repete o que o cliente ja viu', async () => {
    harness = await createServerHarness()
    const { runId, seqs } = await runWithEvents(harness)
    const cut = seqs[2]
    expect(cut).toBeDefined()
    const capture = await captureStream(harness.app, `/api/runs/${runId}/stream?since=${cut}`, {
      events: 3,
    })
    expect(capture.events[0]?.seq).toBe(seqs[3])
    expect(capture.events.map((event) => event.seq)).toEqual(seqs.slice(3, 6))
  })

  it('RECONEXAO: desconectar e voltar com o ultimo seq nao perde nem duplica', async () => {
    harness = await createServerHarness()
    const { runId, seqs } = await runWithEvents(harness)
    expect(seqs.length).toBeGreaterThan(6)

    const half = Math.floor(seqs.length / 2)
    const first = await captureStream(harness.app, `/api/runs/${runId}/stream?since=0`, {
      events: half,
    })
    const seen = first.events.map((event) => event.seq)
    expect(seen).toEqual(seqs.slice(0, half))

    const last = seen[seen.length - 1]
    const second = await captureStream(harness.app, `/api/runs/${runId}/stream?since=${last}`, {
      events: seqs.length - half,
    })
    const resumed = second.events.map((event) => event.seq)

    // A sequencia completa reconstruida das DUAS conexoes e exatamente a do event log.
    expect([...seen, ...resumed]).toEqual(seqs)
    expect(new Set([...seen, ...resumed]).size).toBe(seqs.length)
  }, 30_000)

  it('cada evento carrega o `id` igual ao `seq` — e o cursor da reconexao', async () => {
    harness = await createServerHarness()
    const { runId, seqs } = await runWithEvents(harness)
    const controller = new AbortController()
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/stream?since=0`,
      payloadAsStream: true,
      signal: controller.signal,
    })
    const stream = response.stream()
    stream.on('error', () => undefined)
    let buffer = ''
    const ids: number[] = []
    try {
      for await (const chunk of stream) {
        buffer += String(chunk)
        const parsed = parseSse(buffer)
        buffer = parsed.rest
        for (const message of parsed.messages) {
          if (ids.length >= 3) break
          if (message.id !== undefined) ids.push(message.id)
        }
        if (ids.length >= 3) break
      }
    } finally {
      controller.abort()
    }
    expect(ids).toEqual(seqs.slice(0, 3))
  })

  it('manda heartbeat quando nao ha evento novo', async () => {
    harness = await createServerHarness({ heartbeatMs: 20 })
    const { runId, seqs } = await runWithEvents(harness)
    const last = seqs[seqs.length - 1]
    const capture = await captureStream(harness.app, `/api/runs/${runId}/stream?since=${last}`, {
      comments: 3,
    })
    // O primeiro comentario e o `open`; os demais sao heartbeat.
    expect(capture.comments.filter((item) => item === 'heartbeat').length).toBeGreaterThanOrEqual(1)
  }, 30_000)

  it('publica a saude dos providers no mesmo stream', async () => {
    harness = await createServerHarness({ heartbeatMs: 20 })
    const { runId, seqs } = await runWithEvents(harness)
    const last = seqs[seqs.length - 1]
    const capture = await captureStream(harness.app, `/api/runs/${runId}/stream?since=${last}`, {
      providers: 1,
    })
    expect(capture.providers.length).toBeGreaterThanOrEqual(1)
    const first = capture.providers[0] as { providerId: string }[]
    expect(first[0]?.providerId).toBe('mock')
  }, 30_000)

  it('o servidor continua inteiro depois de o cliente sumir, e a proxima conexao retoma', async () => {
    harness = await createServerHarness({ heartbeatMs: 20 })
    const { runId, seqs } = await runWithEvents(harness, false)
    const last = seqs[seqs.length - 1]

    // Conexao que morre sem ler nada de novo.
    const abandoned = await captureStream(harness.app, `/api/runs/${runId}/stream?since=${last}`, {
      comments: 2,
    })
    expect(abandoned.statusCode).toBe(200)

    // Um comando humano gera evento novo: a conexao seguinte recebe SO ele.
    const skipped = await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tasks/T02/skip`,
      payload: { actor: ACTOR, reason: 'nao e necessaria nesta entrega' },
    })
    expect(skipped.statusCode).toBe(200)
    const events = await harness.plane.persistence.events.list(runId as RunId)
    const created = events.filter((event) => event.seq > (last ?? 0))
    expect(created.length).toBeGreaterThan(0)

    const capture = await captureStream(harness.app, `/api/runs/${runId}/stream?since=${last}`, {
      events: created.length,
    })
    expect(capture.events.map((event) => event.seq)).toEqual(created.map((event) => event.seq))
  }, 30_000)

  it('stream de run inexistente responde 404 antes de abrir o canal', async () => {
    harness = await createServerHarness()
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/runs/01J0000000000000000000000A/stream',
    })
    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toContain('application/json')
  })

  it('`since` invalido no stream tambem e recusado', async () => {
    harness = await createServerHarness()
    const { runId } = await runWithEvents(harness)
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/stream?since=-3`,
    })
    expect(response.statusCode).toBe(400)
  })
})
