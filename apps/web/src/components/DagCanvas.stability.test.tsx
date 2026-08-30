import { act, render, screen } from '@testing-library/react'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { type JSX, useEffect } from 'react'
import { describe, expect, it } from 'vitest'
import { makeEventBurst, makeSnapshot, makeWideSnapshot } from '../__fixtures__/snapshot.js'
import { applyEvent, initRunState, type RunState } from '../lib/run-state.js'
import { installReactFlowEnv } from '../test/react-flow-env.js'
import { DagCanvas } from './DagCanvas.js'

installReactFlowEnv()

const noop = (): void => {}

type Pan = (viewport: { x: number; y: number; zoom: number }) => void

let pan: Pan | undefined

/** Da acesso ao viewport do react-flow: o teste simula o usuario que ja moveu a tela. */
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
  const viewport = document.querySelector('.react-flow__viewport')
  return (viewport as HTMLElement | null)?.style.transform
}

function statuses(): Record<string, string | null> {
  const found: Record<string, string | null> = {}
  for (const element of document.querySelectorAll('.task-node')) {
    const label = element.getAttribute('aria-label') ?? ''
    const id = label.slice(0, 3)
    found[id] = element.getAttribute('data-status')
  }
  return found
}

describe('geometria estavel sob rajada de eventos', () => {
  it('12 eventos sobre 17 nos: nenhuma posicao muda', () => {
    let state: RunState = initRunState(makeSnapshot())
    const view = render(
      <DagCanvas
        snapshot={state.snapshot}
        grouping="phase"
        onGroupingChange={noop}
        selectedTaskId="T09"
        onSelectTask={noop}
      />,
    )
    const before = positions()
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(17)

    for (const event of makeEventBurst()) {
      state = applyEvent(state, event)
      view.rerender(
        <DagCanvas
          snapshot={state.snapshot}
          grouping="phase"
          onGroupingChange={noop}
          selectedTaskId="T09"
          onSelectTask={noop}
        />,
      )
      expect(positions()).toEqual(before)
    }
  })

  it('a rajada muda estado — e so estado', () => {
    let state: RunState = initRunState(makeSnapshot())
    const view = render(
      <DagCanvas
        snapshot={state.snapshot}
        grouping="phase"
        onGroupingChange={noop}
        onSelectTask={noop}
      />,
    )
    const before = { positions: positions(), statuses: statuses() }
    for (const event of makeEventBurst()) state = applyEvent(state, event)
    view.rerender(
      <DagCanvas
        snapshot={state.snapshot}
        grouping="phase"
        onGroupingChange={noop}
        onSelectTask={noop}
      />,
    )
    expect(positions()).toEqual(before.positions)
    expect(statuses()).not.toEqual(before.statuses)
    expect(screen.getByTestId('task-node-T12').getAttribute('data-status')).toBe('DONE')
    expect(screen.getByTestId('task-node-T13').getAttribute('data-status')).toBe('SKIPPED')
  })

  it('a selecao sobrevive a rajada', () => {
    let state: RunState = initRunState(makeSnapshot())
    const view = render(
      <DagCanvas
        snapshot={state.snapshot}
        grouping="phase"
        onGroupingChange={noop}
        selectedTaskId="T11"
        onSelectTask={noop}
      />,
    )
    expect(screen.getByTestId('task-node-T11').className).toContain('task-node--picked')
    for (const event of makeEventBurst()) state = applyEvent(state, event)
    view.rerender(
      <DagCanvas
        snapshot={state.snapshot}
        grouping="phase"
        onGroupingChange={noop}
        selectedTaskId="T11"
        onSelectTask={noop}
      />,
    )
    const picked = document.querySelectorAll('.task-node--picked')
    expect(picked).toHaveLength(1)
    expect(screen.getByTestId('task-node-T11').className).toContain('task-node--picked')
  })

  it('o viewport que o usuario moveu sobrevive a rajada', async () => {
    let state: RunState = initRunState(makeSnapshot())
    const canvas = (snapshot: RunState['snapshot']): JSX.Element => (
      <ReactFlowProvider>
        <ViewportHandle />
        <DagCanvas
          snapshot={snapshot}
          grouping="phase"
          onGroupingChange={noop}
          selectedTaskId="T09"
          onSelectTask={noop}
        />
      </ReactFlowProvider>
    )
    const view = render(canvas(state.snapshot))

    await act(async () => {
      pan?.({ x: -120, y: -80, zoom: 0.75 })
    })
    const moved = viewportTransform()
    expect(moved).toBe('translate(-120px,-80px) scale(0.75)')

    for (const event of makeEventBurst()) {
      state = applyEvent(state, event)
      view.rerender(canvas(state.snapshot))
      expect(viewportTransform()).toBe(moved)
    }
    expect(screen.getByTestId('task-node-T09').className).toContain('task-node--picked')
  })

  it('30 nos: a geometria depende so do grafo congelado', () => {
    const wide = makeWideSnapshot(30)
    const view = render(
      <DagCanvas snapshot={wide} grouping="phase" onGroupingChange={noop} onSelectTask={noop} />,
    )
    const before = positions()
    expect(Object.keys(before).filter((id) => id.startsWith('W'))).toHaveLength(30)

    const changed = {
      ...wide,
      tasks: wide.tasks.map((task) => ({ ...task, status: 'DONE' as const })),
    }
    view.rerender(
      <DagCanvas snapshot={changed} grouping="phase" onGroupingChange={noop} onSelectTask={noop} />,
    )
    expect(positions()).toEqual(before)
  })
})

describe('motivo de espera no no', () => {
  it('o no de uma task parada mostra por quem espera, nao so PENDING', () => {
    render(
      <DagCanvas
        snapshot={makeSnapshot()}
        grouping="phase"
        onGroupingChange={noop}
        onSelectTask={noop}
      />,
    )
    expect(screen.getByTestId('task-waiting-T11').textContent).toBe('aguardando T09')
    expect(screen.getByTestId('task-node-T11').textContent).toContain('PENDING')
  })

  it('o rotulo acessivel do no carrega o motivo da espera', () => {
    render(
      <DagCanvas
        snapshot={makeSnapshot()}
        grouping="phase"
        onGroupingChange={noop}
        onSelectTask={noop}
      />,
    )
    expect(screen.getByTestId('task-node-T14').getAttribute('aria-label')).toBe(
      'T14 Guia do componente — estado BLOCKED, fase docs, aguardando decisão humana',
    )
  })

  it('task em andamento continua mostrando executor e duracao, sem motivo de espera', () => {
    render(
      <DagCanvas
        snapshot={makeSnapshot()}
        grouping="phase"
        onGroupingChange={noop}
        onSelectTask={noop}
      />,
    )
    expect(screen.queryByTestId('task-waiting-T09')).toBeNull()
    expect(screen.getByTestId('task-node-T09').getAttribute('aria-label')).toBe(
      'T09 Painel de propriedades — estado RUNNING, fase frontend',
    )
  })
})
