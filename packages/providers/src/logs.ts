import type { AgentLogEvent } from '@agentic/domain'

/**
 * Log do agente com replay: `logs()` chamado depois do termino ainda entrega tudo, e
 * dois consumidores veem a mesma sequencia. Sem isso, o artefato de log dependeria de
 * alguem ter assinado o stream no instante certo.
 */
export class AgentLogRecorder {
  readonly #events: AgentLogEvent[] = []
  readonly #wakers = new Set<() => void>()
  readonly #now: () => number
  #closed = false

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  get closed(): boolean {
    return this.#closed
  }

  get events(): readonly AgentLogEvent[] {
    return this.#events
  }

  push(stream: AgentLogEvent['stream'], chunk: string): void {
    if (this.#closed) return
    this.#events.push({ ts: new Date(this.#now()), stream, chunk })
    this.#wake()
  }

  pushAll(stream: AgentLogEvent['stream'], chunks: readonly string[]): void {
    for (const chunk of chunks) this.push(stream, chunk)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#wake()
  }

  /** Texto acumulado de um dos streams, na ordem em que chegou. */
  text(stream: AgentLogEvent['stream']): string[] {
    return this.#events.filter((event) => event.stream === stream).map((event) => event.chunk)
  }

  /** Consome do inicio: cada chamada abre um cursor proprio. */
  stream(): AsyncIterable<AgentLogEvent> {
    const events = this.#events
    const wait = (): Promise<void> => this.#wait()
    const isClosed = (): boolean => this.#closed
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<AgentLogEvent> {
        let index = 0
        for (;;) {
          while (index < events.length) {
            const event = events[index]
            index += 1
            if (event !== undefined) yield event
          }
          if (isClosed()) return
          await wait()
        }
      },
    }
  }

  #wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#wakers.add(resolve)
    })
  }

  #wake(): void {
    const wakers = [...this.#wakers]
    this.#wakers.clear()
    for (const waker of wakers) waker()
  }
}

/** Bombeia um stream do processo para o log ate o fim. Nunca lanca. */
export async function pumpInto(
  recorder: AgentLogRecorder,
  stream: AgentLogEvent['stream'],
  source: AsyncIterable<string>,
): Promise<void> {
  try {
    for await (const line of source) recorder.push(stream, line)
  } catch {
    // stream interrompido nao invalida o que ja foi observado
  }
}
