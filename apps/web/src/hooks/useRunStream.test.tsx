import type { RunSnapshot } from '@agentic/schemas'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSnapshot, taskDoneEvent } from '../__fixtures__/snapshot.js'
import { type EventSourceLike, useRunStream } from './useRunStream.js'

type Listener = (event: { data?: unknown }) => void

class FakeEventSource implements EventSourceLike {
  static opened: FakeEventSource[] = []

  readonly url: string
  closed = false
  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.opened.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const bucket = this.listeners.get(type)
    if (bucket === undefined) this.listeners.set(type, [listener])
    else bucket.push(listener)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, payload?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: payload === undefined ? undefined : JSON.stringify(payload) })
    }
  }
}

const snapshot: RunSnapshot = makeSnapshot()
const deps = {
  fetchSnapshot: async (): Promise<RunSnapshot> => makeSnapshot(),
  createEventSource: (url: string): EventSourceLike => new FakeEventSource(url),
  reconnectDelayMs: 0,
}

const last = (): FakeEventSource => {
  const source = FakeEventSource.opened.at(-1)
  if (source === undefined) throw new Error('nenhum stream aberto')
  return source
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
  })
}

beforeEach(() => {
  FakeEventSource.opened = []
})

describe('useRunStream', () => {
  it('carrega o snapshot inicial e abre o stream a partir de since=0', async () => {
    const view = renderHook(() => useRunStream('run-1', deps))
    await waitFor(() => expect(view.result.current.state).toBeDefined())
    expect(view.result.current.state?.snapshot.run.missionId).toBe(snapshot.run.missionId)
    expect(view.result.current.lastStreamUrl).toBe('/api/runs/run-1/stream?since=0')
    expect(view.result.current.phase).toBe('live')
  })

  it('aplica evento incremental sem refazer o fetch do snapshot', async () => {
    const view = renderHook(() => useRunStream('run-1', deps))
    await waitFor(() => expect(view.result.current.state).toBeDefined())
    const opened = FakeEventSource.opened.length

    await act(async () => {
      last().emit('message', taskDoneEvent('T09', 501))
    })

    const tasks = view.result.current.state?.snapshot.tasks ?? []
    expect(tasks.find((task) => task.id === 'T09')?.status).toBe('DONE')
    expect(tasks.find((task) => task.id === 'T11')?.status).toBe('READY')
    expect(FakeEventSource.opened).toHaveLength(opened)
  })

  it('reconecta a partir do ultimo seq e nao duplica o evento ja aplicado', async () => {
    const view = renderHook(() => useRunStream('run-1', deps))
    await waitFor(() => expect(view.result.current.state).toBeDefined())

    await act(async () => {
      last().emit('message', taskDoneEvent('T09', 501))
    })
    expect(view.result.current.state?.events).toHaveLength(1)

    const dropped = last()
    await act(async () => {
      dropped.emit('error')
    })
    await settle()

    expect(dropped.closed).toBe(true)
    expect(view.result.current.lastStreamUrl).toBe('/api/runs/run-1/stream?since=501')
    expect(view.result.current.connections).toBe(2)

    // O servidor pode reenviar o limite da janela: o redutor descarta pelo `seq`.
    await act(async () => {
      last().emit('message', taskDoneEvent('T09', 501))
    })
    expect(view.result.current.state?.events).toHaveLength(1)
    expect(view.result.current.state?.lastSeq).toBe(501)
  })

  it('atualiza running/capacity dos providers pelo mesmo stream', async () => {
    const view = renderHook(() => useRunStream('run-1', deps))
    await waitFor(() => expect(view.result.current.state).toBeDefined())

    await act(async () => {
      last().emit('providers', [
        {
          providerId: 'agente-a',
          installed: true,
          ready: 'unknown',
          version: '2.1.4',
          detail: '',
          running: 3,
          capacity: 3,
        },
      ])
    })

    expect(view.result.current.state?.snapshot.providers).toHaveLength(1)
    expect(view.result.current.state?.snapshot.providers[0]?.running).toBe(3)
  })

  it('ignora carga fora do contrato em vez de corromper a tela', async () => {
    const view = renderHook(() => useRunStream('run-1', deps))
    await waitFor(() => expect(view.result.current.state).toBeDefined())
    const before = view.result.current.state

    await act(async () => {
      last().emit('message', { seq: 'nao e numero' })
    })

    expect(view.result.current.state).toBe(before)
  })

  it('reporta falha do snapshot inicial sem abrir stream', async () => {
    const failing = {
      ...deps,
      fetchSnapshot: async (): Promise<RunSnapshot> => {
        throw new Error('control plane fora do ar')
      },
    }
    const view = renderHook(() => useRunStream('run-1', failing))
    await waitFor(() => expect(view.result.current.phase).toBe('error'))
    expect(view.result.current.error).toBe('control plane fora do ar')
    expect(FakeEventSource.opened).toHaveLength(0)
  })

  it('fecha o stream ao desmontar', async () => {
    const view = renderHook(() => useRunStream('run-1', deps))
    await waitFor(() => expect(view.result.current.state).toBeDefined())
    const opened = last()
    view.unmount()
    expect(opened.closed).toBe(true)
  })
})
