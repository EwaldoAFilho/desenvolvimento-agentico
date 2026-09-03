import type { HostState, HostToWebviewBridge, WebviewToHostBridge } from './bridge-protocol.js'

/**
 * O lado da WEBVIEW da ponte, sem DOM: transforma `request(path, init)` do cliente do
 * dashboard em mensagens `api` e um `EventSource` em mensagens `stream.*`. `dispatch`
 * recebe o que o host manda. Testavel em Node; `media/app.tsx` so cola ao `postMessage`.
 */
export interface BridgedResponse {
  readonly status: number
  readonly ok: boolean
  text(): Promise<string>
}

export interface BridgedEventSource {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
  close(): void
}

export interface ClientBridge {
  request(
    path: string,
    init?: { readonly method?: string; readonly body?: unknown },
  ): Promise<BridgedResponse>
  createEventSource(url: string): BridgedEventSource
  onHostState(listener: (state: HostState) => void): () => void
  dispatch(message: unknown): void
  /** Pendencias em voo (diagnostico e teste). */
  readonly pending: number
}

export function createClientBridge(post: (message: WebviewToHostBridge) => void): ClientBridge {
  let nextId = 1
  const pending = new Map<number, (result: BridgedResponse) => void>()
  const streams = new Map<number, Map<string, ((event: { data?: unknown }) => void)[]>>()
  const hostListeners = new Set<(state: HostState) => void>()

  return {
    get pending(): number {
      return pending.size
    },
    request: (path, init) =>
      new Promise<BridgedResponse>((resolve) => {
        const id = nextId++
        const method = init?.method === 'POST' ? 'POST' : 'GET'
        const body = typeof init?.body === 'string' ? init.body : undefined
        pending.set(id, resolve)
        post({ type: 'api', id, method, path, ...(body === undefined ? {} : { body }) })
      }),
    createEventSource: (url) => {
      const streamId = nextId++
      const listeners = new Map<string, ((event: { data?: unknown }) => void)[]>()
      streams.set(streamId, listeners)
      // `url` chega como `/api/runs/<id>/stream?since=N`; a ponte quer o caminho SEM `/api`.
      const path = url.startsWith('/api') ? url.slice(4) : url
      post({ type: 'stream.open', streamId, path })
      return {
        addEventListener: (type, listener) => {
          const list = listeners.get(type) ?? []
          list.push(listener)
          listeners.set(type, list)
        },
        close: () => {
          if (!streams.delete(streamId)) return
          post({ type: 'stream.close', streamId })
        },
      }
    },
    onHostState: (listener) => {
      hostListeners.add(listener)
      return () => {
        hostListeners.delete(listener)
      }
    },
    dispatch: (raw) => {
      if (typeof raw !== 'object' || raw === null) return
      const message = raw as HostToWebviewBridge
      switch (message.type) {
        case 'api.result': {
          const resolve = pending.get(message.id)
          if (resolve === undefined) return
          pending.delete(message.id)
          resolve({
            status: message.status,
            ok: message.ok,
            text: () => Promise.resolve(message.text),
          })
          return
        }
        case 'stream.event': {
          const listeners = streams.get(message.streamId)
          if (listeners === undefined) return
          for (const listener of listeners.get(message.event.type) ?? []) {
            listener({ data: message.event.data })
          }
          return
        }
        case 'stream.closed': {
          const listeners = streams.get(message.streamId)
          if (listeners === undefined) return
          for (const listener of listeners.get('error') ?? []) listener({ data: message.error })
          return
        }
        case 'host':
          for (const listener of hostListeners) listener(message.state)
          return
        default:
          return
      }
    },
  }
}
