import type { RunSnapshot, TaskDetail } from '@agentic/schemas'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { type JSX, useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  makeEventBurst,
  makeSnapshot,
  makeTaskDetail,
  taskDoneEvent,
} from '../__fixtures__/snapshot.js'
import type { EventSourceLike } from '../hooks/useRunStream.js'
import { installReactFlowEnv } from '../test/react-flow-env.js'
import { RunDashboard } from './RunDashboard.js'

installReactFlowEnv()

type Listener = (event: { data?: unknown }) => void

class FakeEventSource implements EventSourceLike {
  static opened: FakeEventSource[] = []

  private readonly listeners = new Map<string, Listener[]>()

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const bucket = this.listeners.get(type)
    if (bucket === undefined) this.listeners.set(type, [listener])
    else bucket.push(listener)
  }

  close(): void {}

  emit(type: string, payload: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(payload) })
    }
  }
}

let pan: ((viewport: { x: number; y: number; zoom: number }) => void) | undefined

function ViewportHandle(): JSX.Element | null {
  const flow = useReactFlow()
  useEffect(() => {
    pan = (viewport) => {
      void flow.setViewport(viewport)
    }
  }, [flow])
  return null
}

function positions(): Record<string, string> {
  const found: Record<string, string> = {}
  for (const element of document.querySelectorAll('.react-flow__node')) {
    const id = element.getAttribute('data-id')
    if (id !== null) found[id] = (element as HTMLElement).style.transform
  }
  return found
}

function viewportTransform(): string | undefined {
  return (document.querySelector('.react-flow__viewport') as HTMLElement | null)?.style.transform
}

interface Mounted {
  readonly loadTaskDetail: ReturnType<typeof vi.fn>
  readonly source: () => FakeEventSource | undefined
}

async function mount(detail: TaskDetail = makeTaskDetail()): Promise<Mounted> {
  FakeEventSource.opened = []
  const loadTaskDetail = vi.fn(async (): Promise<TaskDetail> => detail)
  render(
    <ReactFlowProvider>
      <ViewportHandle />
      <RunDashboard
        runId="run-1"
        streamDeps={{
          fetchSnapshot: async (): Promise<RunSnapshot> => makeSnapshot(),
          createEventSource: (url) => new FakeEventSource(url),
          reconnectDelayMs: 0,
        }}
        loadTaskDetail={loadTaskDetail}
      />
    </ReactFlowProvider>,
  )
  await waitFor(() => expect(screen.getByTestId('task-node-T09')).toBeTruthy())
  return { loadTaskDetail, source: () => FakeEventSource.opened.at(-1) }
}

describe('rajada de eventos SSE no dashboard', () => {
  it('nenhum no muda de posicao ao longo de 12 eventos', async () => {
    const mounted = await mount()
    const before = positions()
    for (const event of makeEventBurst()) {
      await act(async () => {
        mounted.source()?.emit('message', event)
      })
      expect(positions()).toEqual(before)
    }
    expect(screen.getByTestId('task-node-T12').getAttribute('data-status')).toBe('DONE')
  })

  it('o viewport movido pelo usuario nao e resetado por evento nenhum', async () => {
    const mounted = await mount()
    await act(async () => {
      pan?.({ x: -240, y: -60, zoom: 0.5 })
    })
    expect(viewportTransform()).toBe('translate(-240px,-60px) scale(0.5)')
    for (const event of makeEventBurst()) {
      await act(async () => {
        mounted.source()?.emit('message', event)
      })
    }
    expect(viewportTransform()).toBe('translate(-240px,-60px) scale(0.5)')
  })

  it('a task selecionada continua selecionada e o detalhe nao e refeito', async () => {
    const mounted = await mount()
    fireEvent.click(screen.getByTestId('task-node-T09'))
    await waitFor(() => expect(screen.getByLabelText('Detalhe da task T09')).toBeTruthy())
    expect(mounted.loadTaskDetail).toHaveBeenCalledTimes(1)

    for (const event of makeEventBurst()) {
      await act(async () => {
        mounted.source()?.emit('message', event)
      })
    }

    expect(screen.getByLabelText('Detalhe da task T09')).toBeTruthy()
    expect(screen.getByTestId('task-node-T09').className).toContain('task-node--picked')
    expect(document.querySelectorAll('.task-node--picked')).toHaveLength(1)
    expect(mounted.loadTaskDetail).toHaveBeenCalledTimes(1)
  })

  it('o motivo de espera do painel acompanha o estado que chegou pelo stream', async () => {
    const mounted = await mount({ ...makeTaskDetail(), id: 'T11', status: 'PENDING' })
    fireEvent.click(screen.getByTestId('task-node-T11'))
    await waitFor(() => expect(screen.getByTestId('waiting-cause')).toBeTruthy())
    expect(screen.getByTestId('waiting-cause').textContent).toBe('aguardando T09')

    await act(async () => {
      mounted.source()?.emit('message', taskDoneEvent('T09', 900))
    })

    expect(screen.getByTestId('task-node-T11').getAttribute('data-status')).toBe('READY')
    expect(screen.getByTestId('waiting-cause').textContent).toBe('aguardando despacho')
  })

  it('o no parado mostra o motivo em vez de so o estado', async () => {
    await mount()
    expect(screen.getByTestId('task-waiting-T16').textContent).toBe('aguardando T12, T13, T15')
    expect(screen.getByTestId('task-waiting-T14').textContent).toBe('aguardando decisão humana')
  })
})
