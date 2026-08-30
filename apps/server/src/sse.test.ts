import type { ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { HEARTBEAT_FRAME, SseChannel, sseFrame } from './sse.js'

class FakeResponse {
  readonly chunks: string[] = []
  status: number | undefined
  headers: Record<string, string> | undefined
  destroyed = false
  writableEnded = false

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status
    this.headers = headers
  }

  write(chunk: string): boolean {
    if (this.destroyed) throw new Error('socket destruido')
    this.chunks.push(chunk)
    return true
  }

  end(): void {
    this.writableEnded = true
  }
}

const channelOf = (fake: FakeResponse): SseChannel =>
  new SseChannel(fake as unknown as ServerResponse)

describe('quadro SSE', () => {
  it('carrega o `seq` como `id`: e o cursor da reconexao', () => {
    expect(sseFrame('event', { seq: 12 }, 12)).toBe('id: 12\nevent: event\ndata: {"seq":12}\n\n')
  })

  it('sem id emite apenas o evento nomeado', () => {
    expect(sseFrame('providers', [])).toBe('event: providers\ndata: []\n\n')
  })
})

describe('canal SSE', () => {
  it('abre com os cabecalhos de stream e um primeiro byte', () => {
    const fake = new FakeResponse()
    channelOf(fake).open()
    expect(fake.status).toBe(200)
    expect(fake.headers?.['content-type']).toContain('text/event-stream')
    expect(fake.headers?.['cache-control']).toContain('no-cache')
    expect(fake.chunks[0]).toBe(': open\n\n')
  })

  it('heartbeat e comentario, nao evento', () => {
    const fake = new FakeResponse()
    const channel = channelOf(fake)
    channel.heartbeat()
    expect(fake.chunks).toEqual([HEARTBEAT_FRAME])
  })

  it('depois do close nao escreve mais nada', () => {
    const fake = new FakeResponse()
    const channel = channelOf(fake)
    channel.close()
    expect(channel.send('event', { seq: 1 }, 1)).toBe(false)
    expect(fake.chunks).toEqual([])
  })

  it('close e idempotente', () => {
    const fake = new FakeResponse()
    const channel = channelOf(fake)
    channel.close()
    channel.close()
    expect(fake.writableEnded).toBe(true)
  })

  it('socket que morre no meio fecha o canal em silencio', () => {
    const fake = new FakeResponse()
    const channel = channelOf(fake)
    fake.destroyed = true
    expect(channel.closed).toBe(true)
    expect(channel.write('x')).toBe(false)
  })
})
