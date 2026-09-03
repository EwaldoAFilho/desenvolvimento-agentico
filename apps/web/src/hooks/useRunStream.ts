import { EventDtoSchema, ProviderHealthDtoSchema, type RunSnapshot } from '@agentic/schemas'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getRunSnapshot, streamUrl } from '../api.js'
import { applyEvent, applyProviders, initRunState, type RunState } from '../lib/run-state.js'

export type StreamPhase = 'loading' | 'live' | 'reconnecting' | 'error'

/** So o que o hook usa de `EventSource` — o teste injeta um duble sem depender do jsdom. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
  close(): void
}

export interface RunStreamDeps {
  readonly fetchSnapshot?: (runId: string) => Promise<RunSnapshot>
  readonly createEventSource?: (url: string) => EventSourceLike
  readonly reconnectDelayMs?: number
}

export interface RunStreamResult {
  readonly state: RunState | undefined
  readonly phase: StreamPhase
  readonly error: string | undefined
  /** Quantas vezes o stream foi aberto. Reconexao aumenta — util para diagnostico e teste. */
  readonly connections: number
  readonly lastStreamUrl: string | undefined
  /**
   * Pedir o snapshot de novo depois de uma falha. A reconexao automatica so existe DEPOIS
   * do primeiro snapshot; se ele falhar, sem isto a tela fica com a mensagem e nenhuma
   * saida a nao ser o F5 — que perde a navegacao.
   */
  readonly reload: () => void
}

function defaultEventSource(url: string): EventSourceLike {
  if (typeof EventSource === 'undefined') {
    throw new Error('EventSource indisponivel neste ambiente')
  }
  return new EventSource(url) as unknown as EventSourceLike
}

function parseData(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * Snapshot inicial + SSE incremental. Sem polling: o estado da tela e o snapshot com os
 * eventos aplicados por cima, e a reconexao pede `since=<ultimo seq>` — sem lacuna e sem
 * duplicata (DASHBOARD 6, ARCHITECTURE 6.3).
 */
export function useRunStream(runId: string | undefined, deps: RunStreamDeps = {}): RunStreamResult {
  const {
    fetchSnapshot = getRunSnapshot,
    createEventSource = defaultEventSource,
    reconnectDelayMs = 1000,
  } = deps

  const [state, setState] = useState<RunState | undefined>(undefined)
  const [phase, setPhase] = useState<StreamPhase>('loading')
  const [error, setError] = useState<string | undefined>(undefined)
  const [connections, setConnections] = useState(0)
  const [lastStreamUrl, setLastStreamUrl] = useState<string | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const stateRef = useRef<RunState | undefined>(undefined)

  const reload = useCallback((): void => setAttempt((count) => count + 1), [])

  const push = useCallback((next: RunState) => {
    stateRef.current = next
    setState(next)
  }, [])

  useEffect(() => {
    if (runId === undefined) {
      setPhase('loading')
      return
    }
    let cancelled = false
    let source: EventSourceLike | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const onEvent = (message: { data?: unknown }): void => {
      const parsed = EventDtoSchema.safeParse(parseData(message.data))
      const current = stateRef.current
      if (!parsed.success || current === undefined) return
      push(applyEvent(current, parsed.data))
    }

    const onProviders = (message: { data?: unknown }): void => {
      const parsed = ProviderHealthDtoSchema.array().safeParse(parseData(message.data))
      const current = stateRef.current
      if (!parsed.success || current === undefined) return
      push(applyProviders(current, parsed.data))
    }

    const connect = (): void => {
      if (cancelled) return
      const url = streamUrl(runId, stateRef.current?.lastSeq ?? 0)
      const opened = createEventSource(url)
      source = opened
      setLastStreamUrl(url)
      setConnections((count) => count + 1)
      setPhase('live')
      opened.addEventListener('message', onEvent)
      // O servidor pode nomear o evento; ambos os canais carregam o mesmo `EventDto`.
      opened.addEventListener('event', onEvent)
      opened.addEventListener('providers', onProviders)
      opened.addEventListener('error', () => {
        if (cancelled) return
        setPhase('reconnecting')
        opened.close()
        timer = setTimeout(connect, reconnectDelayMs)
      })
    }

    setPhase('loading')
    setError(undefined)
    fetchSnapshot(runId)
      .then((snapshot) => {
        if (cancelled) return
        push(initRunState(snapshot))
        connect()
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        const detail = cause instanceof Error ? cause.message : String(cause)
        // A contagem entra na mensagem porque duas falhas iguais em sequencia sao
        // indistinguiveis na tela: sem ela, "tentar novamente" parece nao ter feito nada.
        setError(attempt === 0 ? detail : `${detail} (tentativa ${attempt + 1})`)
        setPhase('error')
      })

    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      source?.close()
    }
  }, [runId, fetchSnapshot, createEventSource, reconnectDelayMs, push, attempt])

  return { state, phase, error, connections, lastStreamUrl, reload }
}
