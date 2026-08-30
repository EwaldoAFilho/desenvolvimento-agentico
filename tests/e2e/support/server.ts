import type { RunId } from '@agentic/domain'
import type { EventDto } from '@agentic/schemas'
import type { RunLauncher } from '@agentic/server'
import { createServer } from '@agentic/server'
import type { FastifyInstance } from 'fastify'
import type { MissionHarness } from './harness.js'

export interface AppOptions {
  /** Ausente = launcher real: o POST liga o loop do orquestrador, como o dashboard faz. */
  readonly launcher?: RunLauncher
  readonly heartbeatMs?: number
}

/** O servidor do produto sobre o control plane do harness. Nenhuma porta e aberta. */
export function createApp(harness: MissionHarness, options: AppOptions = {}): FastifyInstance {
  return createServer({
    plane: harness.plane,
    project: harness.project,
    projectText: harness.sources.projectText,
    gatesText: harness.sources.gatesText,
    repoRoot: harness.root,
    heartbeatMs: options.heartbeatMs ?? 60_000,
    ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
  })
}

/** Registra quais runs o servidor mandou orquestrar — o contador do START MISSION. */
export function recordingLauncher(harness: MissionHarness): {
  readonly launcher: RunLauncher
  readonly launched: readonly RunId[]
} {
  const launched: RunId[] = []
  return {
    launched,
    launcher: {
      start: async (runId: RunId): Promise<void> => {
        launched.push(runId)
        const orchestrator = await harness.plane.open(runId)
        orchestrator.start()
      },
    },
  }
}

interface SseMessage {
  readonly event: string
  readonly id: number | undefined
  readonly data: string
}

interface SseParse {
  readonly messages: readonly SseMessage[]
  readonly comments: readonly string[]
  readonly rest: string
}

/** Parser SSE minimo: blocos separados por linha em branco; ignora o que nao entende. */
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

export interface LiveStream {
  readonly statusCode: number
  readonly contentType: string | undefined
  /** Eventos ja entregues pela conexao, em ordem de chegada. */
  readonly events: readonly EventDto[]
  readonly ids: readonly (number | undefined)[]
  waitFor(
    predicate: (events: readonly EventDto[]) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<void>
  close(): void
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Assina o SSE por `inject` e mantem a conexao ABERTA enquanto o run avanca: e assim que
 * o dashboard vive. Nada e refetchado — o que o teste ve e o que chegou pelo stream.
 */
export async function openStream(app: FastifyInstance, url: string): Promise<LiveStream> {
  const controller = new AbortController()
  const response = await app.inject({
    method: 'GET',
    url,
    payloadAsStream: true,
    signal: controller.signal,
  })
  const events: EventDto[] = []
  const ids: (number | undefined)[] = []
  const contentType = response.headers['content-type'] as string | undefined

  if (response.statusCode === 200) {
    const stream = response.stream()
    stream.on('error', () => undefined)
    let buffer = ''
    const pump = async (): Promise<void> => {
      for await (const chunk of stream) {
        buffer += String(chunk)
        const parsed = parseSse(buffer)
        buffer = parsed.rest
        for (const message of parsed.messages) {
          if (message.event !== 'event') continue
          events.push(JSON.parse(message.data) as EventDto)
          ids.push(message.id)
        }
      }
    }
    void pump().catch(() => undefined)
  } else {
    controller.abort()
  }

  return {
    statusCode: response.statusCode,
    contentType,
    events,
    ids,
    waitFor: async (predicate, label, timeoutMs = 60_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs
      while (!predicate(events)) {
        if (Date.now() > deadline) {
          throw new Error(
            `stream: esperei ${label} por ${timeoutMs}ms; ${events.length} evento(s) recebido(s): ` +
              events.map((event) => event.type).join(', '),
          )
        }
        await sleep(10)
      }
    },
    close: (): void => {
      controller.abort()
    },
  }
}
