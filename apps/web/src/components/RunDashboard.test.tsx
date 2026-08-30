import type { RunSnapshot, TaskDetail } from '@agentic/schemas'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeSnapshot, makeTaskDetail, taskDoneEvent } from '../__fixtures__/snapshot.js'
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

function statusOnCanvas(taskId: string): string | null {
  return screen.getByTestId(`task-node-${taskId}`).getAttribute('data-status')
}

describe('RunDashboard', () => {
  it('acende o dependente READY sem refazer o fetch do snapshot', async () => {
    FakeEventSource.opened = []
    const fetchSnapshot = vi.fn(async (): Promise<RunSnapshot> => makeSnapshot())
    render(
      <RunDashboard
        runId="run-1"
        streamDeps={{
          fetchSnapshot,
          createEventSource: (url) => new FakeEventSource(url),
          reconnectDelayMs: 0,
        }}
        loadTaskDetail={async (): Promise<TaskDetail> => makeTaskDetail()}
      />,
    )

    await waitFor(() => expect(screen.getByTestId('task-node-T11')).toBeTruthy())
    expect(statusOnCanvas('T09')).toBe('RUNNING')
    expect(statusOnCanvas('T11')).toBe('PENDING')

    const source = FakeEventSource.opened.at(-1)
    await act(async () => {
      source?.emit('message', taskDoneEvent('T09', 501))
    })

    expect(statusOnCanvas('T09')).toBe('DONE')
    expect(statusOnCanvas('T11')).toBe('READY')
    expect(screen.getByTestId('task-node-T11').textContent).toContain('READY')
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)
  })

  it('o cabecalho reflete o novo contador sem reload', async () => {
    FakeEventSource.opened = []
    render(
      <RunDashboard
        runId="run-1"
        streamDeps={{
          fetchSnapshot: async (): Promise<RunSnapshot> => makeSnapshot(),
          createEventSource: (url) => new FakeEventSource(url),
          reconnectDelayMs: 0,
        }}
        loadTaskDetail={async (): Promise<TaskDetail> => makeTaskDetail()}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('counter-DONE')).toBeTruthy())
    expect(screen.getByTestId('counter-DONE').textContent).toContain('8 DONE')

    const source = FakeEventSource.opened.at(-1)
    await act(async () => {
      source?.emit('message', taskDoneEvent('T09', 501))
    })
    expect(screen.getByTestId('counter-DONE').textContent).toContain('9 DONE')
  })

  it('selecionar um no abre o painel de detalhe da task', async () => {
    FakeEventSource.opened = []
    const loadTaskDetail = vi.fn(async (): Promise<TaskDetail> => makeTaskDetail())
    render(
      <RunDashboard
        runId="run-1"
        streamDeps={{
          fetchSnapshot: async (): Promise<RunSnapshot> => makeSnapshot(),
          createEventSource: (url) => new FakeEventSource(url),
          reconnectDelayMs: 0,
        }}
        loadTaskDetail={loadTaskDetail}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('task-node-T09')).toBeTruthy())
    expect(screen.getByText('selecione uma task no canvas')).toBeTruthy()

    fireEvent.click(screen.getByTestId('task-node-T09'))

    await waitFor(() => expect(screen.getByTestId('worktree-path')).toBeTruthy())
    expect(loadTaskDetail).toHaveBeenCalledWith('run-1', 'T09')
  })

  it('mostra o rodape de eventos recolhivel', async () => {
    FakeEventSource.opened = []
    render(
      <RunDashboard
        runId="run-1"
        streamDeps={{
          fetchSnapshot: async (): Promise<RunSnapshot> => makeSnapshot(),
          createEventSource: (url) => new FakeEventSource(url),
          reconnectDelayMs: 0,
        }}
        loadTaskDetail={async (): Promise<TaskDetail> => makeTaskDetail()}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('event-stream')).toBeTruthy())
    const toggle = screen.getByRole('button', { name: /eventos/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(screen.queryByTestId('event-stream')).toBeNull()
  })
})
