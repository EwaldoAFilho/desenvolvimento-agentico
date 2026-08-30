import type { EventDto } from '@agentic/schemas'
import type { FastifyInstance } from 'fastify'

export interface SseMessage {
  readonly event: string
  readonly id: number | undefined
  readonly data: string
}

export interface SseParse {
  readonly messages: readonly SseMessage[]
  readonly comments: readonly string[]
  readonly rest: string
}

/** Parser SSE minimo: separa blocos por linha em branco e ignora o que nao entende. */
export function parseSse(buffer: string): SseParse {
  const messages: SseMessage[] = []
  const comments: string[] = []
  const blocks = buffer.split('\n\n')
  const rest = blocks.pop() ?? ''
  for (const block of blocks) {
    let event = 'message'
    let id: number | undefined
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.length === 0) continue
      if (line.startsWith(':')) {
        comments.push(line.slice(1).trim())
        continue
      }
      const separator = line.indexOf(':')
      const field = separator === -1 ? line : line.slice(0, separator)
      const value = separator === -1 ? '' : line.slice(separator + 1).trimStart()
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
      else if (field === 'id') id = Number(value)
    }
    if (data.length > 0) messages.push({ event, id, data: data.join('\n') })
  }
  return { messages, comments, rest }
}

export interface StreamCapture {
  readonly statusCode: number
  readonly contentType: string | undefined
  readonly events: readonly EventDto[]
  readonly providers: readonly unknown[]
  readonly comments: readonly string[]
}

export interface CaptureOptions {
  /** Quantos eventos de dominio esperar antes de desconectar. */
  readonly events?: number
  /** Quantos comentarios (heartbeat) esperar antes de desconectar. */
  readonly comments?: number
  readonly providers?: number
}

/**
 * Conecta ao SSE por `inject` (sem porta real), le ate satisfazer o alvo e DESCONECTA
 * abortando a requisicao — e a desconexao de cliente que o teste de reconexao precisa.
 */
export async function captureStream(
  app: FastifyInstance,
  url: string,
  target: CaptureOptions,
): Promise<StreamCapture> {
  const controller = new AbortController()
  const response = await app.inject({
    method: 'GET',
    url,
    payloadAsStream: true,
    signal: controller.signal,
  })
  const contentType = response.headers['content-type'] as string | undefined
  if (response.statusCode !== 200) {
    controller.abort()
    return {
      statusCode: response.statusCode,
      contentType,
      events: [],
      providers: [],
      comments: [],
    }
  }

  const stream = response.stream()
  stream.on('error', () => undefined)
  const events: EventDto[] = []
  const providers: unknown[] = []
  const comments: string[] = []
  let buffer = ''

  const done = (): boolean =>
    events.length >= (target.events ?? 0) &&
    comments.length >= (target.comments ?? 0) &&
    providers.length >= (target.providers ?? 0)

  // O socket pode entregar varias mensagens no MESMO chunk. O cliente para no alvo e
  // desconecta: o que veio depois nunca foi aplicado — e disso que a reconexao se recupera.

  try {
    if (!done()) {
      for await (const chunk of stream) {
        buffer += String(chunk)
        const parsed = parseSse(buffer)
        buffer = parsed.rest
        comments.push(...parsed.comments)
        for (const message of parsed.messages) {
          if (done()) break
          if (message.event === 'providers') providers.push(JSON.parse(message.data))
          else events.push(JSON.parse(message.data) as EventDto)
        }
        if (done()) break
      }
    }
  } finally {
    controller.abort()
  }

  return { statusCode: response.statusCode, contentType, events, providers, comments }
}
