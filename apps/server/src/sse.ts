import type { ServerResponse } from 'node:http'

/** Comentario SSE: mantem a conexao viva sem virar evento para o cliente. */
export const HEARTBEAT_FRAME = ': heartbeat\n\n'

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // Proxy que enfileira mata o produto: o valor do stream e chegar na hora.
  'x-accel-buffering': 'no',
}

/** Uma mensagem SSE: `id` e o `seq` do evento — e com ele que o cliente reconecta. */
export function sseFrame(event: string, data: unknown, id?: number): string {
  const payload = JSON.stringify(data)
  const head = id === undefined ? '' : `id: ${id}\n`
  return `${head}event: ${event}\ndata: ${payload}\n\n`
}

/**
 * Escrita defensiva sobre o socket cru. O cliente pode sumir a qualquer momento; quando
 * some, o canal fecha em silencio em vez de derrubar o processo.
 */
export class SseChannel {
  readonly #raw: ServerResponse
  #closed = false

  constructor(raw: ServerResponse) {
    this.#raw = raw
  }

  get closed(): boolean {
    return this.#closed || this.#raw.destroyed || this.#raw.writableEnded
  }

  open(status = 200): void {
    this.#raw.writeHead(status, { ...SSE_HEADERS })
    // Primeiro byte imediato: o cliente sabe que a conexao esta de pe antes do 1o evento.
    this.write(': open\n\n')
  }

  write(chunk: string): boolean {
    if (this.closed) return false
    try {
      this.#raw.write(chunk)
      return true
    } catch {
      this.#closed = true
      return false
    }
  }

  send(event: string, data: unknown, id?: number): boolean {
    return this.write(sseFrame(event, data, id))
  }

  heartbeat(): boolean {
    return this.write(HEARTBEAT_FRAME)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#raw.end()
    } catch {
      // socket ja foi: encerrar duas vezes nao e erro operacional
    }
  }
}
