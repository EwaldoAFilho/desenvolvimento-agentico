import { describe, expect, it } from 'vitest'
import { createSseParser, openSse, type SseEvent } from './sse.js'

describe('parser de SSE', () => {
  it('junta data multiplas, le event e id, ignora comentarios e despacha na linha vazia', () => {
    const parser = createSseParser()
    expect(parser.push(': open\n\n')).toEqual([])
    expect(parser.push('event: event\nid: 7\ndata: {"a":1}\n')).toEqual([])
    expect(parser.push('\n')).toEqual([{ type: 'event', id: '7', data: '{"a":1}' }])
    expect(parser.push('data: x\r\ndata: y\r\n\r\n')).toEqual([
      { type: 'message', id: '7', data: 'x\ny' },
    ])
  })

  it('pedaco cortado no meio de uma linha e remontado', () => {
    const parser = createSseParser()
    expect(parser.push('event: prov')).toEqual([])
    expect(parser.push('iders\ndata: [')).toEqual([])
    expect(parser.push(']\n\n')).toEqual([{ type: 'providers', data: '[]' }])
  })
})

function streamResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

describe('openSse', () => {
  it('entrega os eventos e fecha limpo no fim do stream', async () => {
    const events: SseEvent[] = []
    const closed = new Promise<string | undefined>((resolve) => {
      openSse(
        'http://x/api/runs/1/stream',
        { 'x-agentic-repo-root': '/repo' },
        { onEvent: (e) => events.push(e), onClose: resolve },
        async (_url, init) => {
          expect(((init?.headers ?? {}) as Record<string, string>)['x-agentic-repo-root']).toBe(
            '/repo',
          )
          return streamResponse([
            ': open\n\n',
            'event: event\nid: 1\ndata: {"seq":1}\n\n',
            'event: event\nid: 2\ndata: {"seq":2}\n\n',
          ])
        },
      )
    })
    expect(await closed).toBeUndefined()
    expect(events.map((e) => e.id)).toEqual(['1', '2'])
  })

  it('HTTP nao-2xx vira fechamento com motivo', async () => {
    const reason = await new Promise<string | undefined>((resolve) => {
      openSse('http://x/s', {}, { onEvent: () => undefined, onClose: resolve }, async () =>
        streamResponse([], 404),
      )
    })
    expect(reason).toBe('HTTP 404')
  })

  it('close() aborta e fecha uma unica vez', async () => {
    let closes = 0
    const sub = openSse(
      'http://x/s',
      {},
      {
        onEvent: () => undefined,
        onClose: () => {
          closes += 1
        },
      },
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    sub.close()
    sub.close()
    await new Promise((r) => setTimeout(r, 10))
    expect(closes).toBe(1)
  })
})
