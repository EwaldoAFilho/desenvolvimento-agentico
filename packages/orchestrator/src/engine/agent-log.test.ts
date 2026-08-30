import type { AgentLogEvent } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import {
  AGENT_LOG_FILE,
  AGENT_LOG_KIND,
  AgentLogCapture,
  agentLogFile,
  agentLogKind,
  REVIEW_LOG_FILE,
  REVIEW_LOG_KIND,
} from './agent-log.js'

const TS = new Date('2026-01-01T00:00:00.000Z')

function event(stream: AgentLogEvent['stream'], chunk: string): AgentLogEvent {
  return { ts: TS, stream, chunk }
}

/** Fonte que entrega os eventos e termina, como um adapter bem comportado. */
function source(events: readonly AgentLogEvent[]): () => AsyncIterable<AgentLogEvent> {
  return () => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<AgentLogEvent> {
      for (const item of events) yield item
    },
  })
}

function lines(content: string): Record<string, unknown>[] {
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const now = (): Date => TS

describe('AgentLogCapture', () => {
  it('grava uma linha JSON por evento, na ordem observada', async () => {
    const capture = new AgentLogCapture(
      source([event('stdout', 'primeira'), event('stdout', 'segunda')]),
      { now },
    )
    const result = await capture.finish()

    expect(result.events).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.problem).toBeUndefined()
    expect(lines(result.content)).toEqual([
      { ts: TS.toISOString(), stream: 'stdout', chunk: 'primeira' },
      { ts: TS.toISOString(), stream: 'stdout', chunk: 'segunda' },
    ])
  })

  it('identifica stdout e stderr separadamente', async () => {
    const capture = new AgentLogCapture(
      source([event('stdout', 'saida'), event('stderr', 'erro')]),
      { now },
    )
    const result = await capture.finish()

    expect(lines(result.content).map((line) => line.stream)).toEqual(['stdout', 'stderr'])
    expect(lines(result.content).map((line) => line.chunk)).toEqual(['saida', 'erro'])
  })

  it('CONTROLE: fonte que lanca na abertura vira nota no artefato, sem propagar', async () => {
    const capture = new AgentLogCapture(
      () => {
        throw new Error('adapter quebrado: logs() indisponivel')
      },
      { now },
    )
    const result = await capture.finish()

    expect(result.events).toBe(0)
    expect(result.problem).toContain('logs() indisponivel')
    expect(lines(result.content)).toEqual([
      {
        ts: TS.toISOString(),
        event: 'log_incomplete',
        detail: 'adapter quebrado: logs() indisponivel',
      },
    ])
  })

  it('stream que quebra no meio preserva o que ja tinha vindo', async () => {
    const capture = new AgentLogCapture(
      () => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<AgentLogEvent> {
          yield event('stdout', 'antes da falha')
          throw new Error('stream interrompido')
        },
      }),
      { now },
    )
    const result = await capture.finish()

    expect(result.events).toBe(1)
    expect(result.problem).toContain('stream interrompido')
    expect(result.content).toContain('antes da falha')
  })

  it('trunca no teto, marca a truncagem e conta o que foi descartado', async () => {
    const big = 'x'.repeat(400)
    const capture = new AgentLogCapture(
      source([event('stdout', big), event('stdout', big), event('stdout', big)]),
      { now, maxBytes: 900 },
    )
    const result = await capture.finish()

    expect(result.truncated).toBe(true)
    expect(result.events).toBe(1)
    expect(result.droppedEvents).toBe(2)
    expect(result.bytes).toBeLessThanOrEqual(900)
    const marker = lines(result.content).at(-1)
    expect(marker).toEqual({
      ts: TS.toISOString(),
      event: 'truncated',
      limitBytes: 900,
      droppedEvents: 2,
    })
  })

  it('mascara segredo antes de a linha existir', async () => {
    const capture = new AgentLogCapture(
      source([event('stderr', 'export API_KEY=super-secreto-123')]),
      { now },
    )
    const result = await capture.finish()

    expect(result.content).not.toContain('super-secreto-123')
    expect(result.content).toContain('[REDACTED]')
  })

  it('aceita redator injetado pelo composition root', async () => {
    const capture = new AgentLogCapture(source([event('stdout', 'valor sensivel')]), {
      now,
      redact: () => 'mascarado por injecao',
    })
    const result = await capture.finish()

    expect(lines(result.content)[0]?.chunk).toBe('mascarado por injecao')
  })

  it('fonte que nunca fecha termina no teto de espera e registra o motivo', async () => {
    const capture = new AgentLogCapture(
      () => ({
        [Symbol.asyncIterator]: (): AsyncIterator<AgentLogEvent> => ({
          next: (): Promise<IteratorResult<AgentLogEvent>> =>
            new Promise<IteratorResult<AgentLogEvent>>(() => undefined),
        }),
      }),
      { now, graceMs: 20 },
    )
    const result = await capture.finish()

    expect(result.problem).toContain('nao terminou em 20ms')
    expect(result.events).toBe(0)
  })

  it('captura vazia produz artefato vazio, sem linha inventada', async () => {
    const capture = new AgentLogCapture(source([]), { now })
    const result = await capture.finish()

    expect(result.content).toBe('')
    expect(result.events).toBe(0)
    expect(result.problem).toBeUndefined()
  })

  it('nomeia arquivo e kind por papel, sem executor e revisor colidirem', () => {
    expect(agentLogFile('execute')).toBe(AGENT_LOG_FILE)
    expect(agentLogFile('review')).toBe(REVIEW_LOG_FILE)
    expect(agentLogKind('execute')).toBe(AGENT_LOG_KIND)
    expect(agentLogKind('review')).toBe(REVIEW_LOG_KIND)
    expect(AGENT_LOG_FILE).not.toBe(REVIEW_LOG_FILE)
  })
})
