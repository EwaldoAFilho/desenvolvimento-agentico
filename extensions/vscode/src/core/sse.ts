/**
 * Leitor de Server-Sent Events sobre `fetch` com corpo em stream — o extension host nao tem
 * `EventSource`, e a webview nao tem rede. O host abre o stream do control plane e repassa
 * cada evento a webview por `postMessage`; a webview enxerga um `EventSourceLike`.
 *
 * Parser minimo do formato: linhas `event:`, `data:` (varias = juntas por `\n`), `id:`;
 * linha vazia despacha; linha iniciada por `:` e comentario (heartbeat). Quem chama decide
 * a reconexao (o hook do dashboard ja o faz, com `since=<lastSeq>`).
 */
export interface SseEvent {
  readonly type: string
  readonly data: string
  readonly id?: string
}

export interface SseFrameParser {
  /** Recebe um pedaco do stream; devolve os eventos completos que ele fechou. */
  push(chunk: string): SseEvent[]
}

export function createSseParser(): SseFrameParser {
  let buffer = ''
  let type = 'message'
  let data: string[] = []
  let id: string | undefined
  const flush = (out: SseEvent[]): void => {
    if (data.length > 0) {
      out.push({ type, data: data.join('\n'), ...(id === undefined ? {} : { id }) })
    }
    type = 'message'
    data = []
  }
  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk
      const out: SseEvent[] = []
      for (;;) {
        const nl = buffer.indexOf('\n')
        if (nl === -1) break
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line.length === 0) {
          flush(out)
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') type = value
        else if (field === 'data') data.push(value)
        else if (field === 'id') id = value
      }
      return out
    },
  }
}

export interface SseSubscription {
  close(): void
}

export interface SseHandlers {
  onEvent(event: SseEvent): void
  /** Fim do stream (fechado pelo servidor) ou falha de transporte. `undefined` = fechou limpo. */
  onClose(error?: string): void
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Abre `url` e entrega eventos ate `close()` ou ate o servidor fechar. Nunca reconecta por
 * conta propria: a reconexao com cursor e decisao de quem consome.
 */
export function openSse(
  url: string,
  headers: Record<string, string>,
  handlers: SseHandlers,
  fetchFn: FetchLike = fetch,
): SseSubscription {
  const controller = new AbortController()
  let closed = false
  const finish = (error?: string): void => {
    if (closed) return
    closed = true
    handlers.onClose(error)
  }
  void (async () => {
    try {
      const response = await fetchFn(url, {
        headers: { accept: 'text/event-stream', ...headers },
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) {
        finish(`HTTP ${response.status}`)
        return
      }
      const parser = createSseParser()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          if (closed) return
          handlers.onEvent(event)
        }
      }
      finish()
    } catch (error) {
      if (controller.signal.aborted) {
        finish()
        return
      }
      finish(error instanceof Error ? error.message : String(error))
    }
  })()
  return {
    close: () => {
      if (closed) return
      closed = true
      controller.abort()
      handlers.onClose()
    },
  }
}
