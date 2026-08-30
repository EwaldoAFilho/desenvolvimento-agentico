import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeSnapshot } from '../__fixtures__/snapshot.js'
import { installReactFlowEnv } from '../test/react-flow-env.js'
import { buildEdges, DagCanvas } from './DagCanvas.js'

installReactFlowEnv()

const noop = (): void => {}

describe('DagCanvas', () => {
  it('renderiza os 17 nos da missao compilada', () => {
    render(
      <DagCanvas
        snapshot={makeSnapshot()}
        grouping="phase"
        onGroupingChange={noop}
        onSelectTask={noop}
      />,
    )
    for (const id of ['T01', 'T09', 'T14', 'T17']) {
      expect(screen.getByTestId(`task-node-${id}`)).toBeTruthy()
    }
    expect(screen.getAllByText(/^T\d\d$/)).toHaveLength(17)
  })

  it('mostra a faixa de cada uma das 7 fases', () => {
    render(
      <DagCanvas
        snapshot={makeSnapshot()}
        grouping="phase"
        onGroupingChange={noop}
        onSelectTask={noop}
      />,
    )
    const phases = ['foundation', 'contracts', 'backend', 'frontend', 'quality', 'docs', 'release']
    for (const phase of phases) {
      expect(screen.getByTestId(`band-${phase}`)).toBeTruthy()
    }
    expect(document.querySelectorAll('.band')).toHaveLength(7)
  })

  it('mantem a posicao dos nos quando so o estado muda', () => {
    const before = makeSnapshot()
    const view = render(
      <DagCanvas snapshot={before} grouping="phase" onGroupingChange={noop} onSelectTask={noop} />,
    )
    const positionsOf = (): Record<string, string> => {
      const found: Record<string, string> = {}
      for (const element of document.querySelectorAll('.react-flow__node')) {
        const id = element.getAttribute('data-id')
        if (id !== null) found[id] = (element as HTMLElement).style.transform
      }
      return found
    }
    const first = positionsOf()

    const after = makeSnapshot()
    after.tasks = after.tasks.map((task) =>
      task.id === 'T09' ? { ...task, status: 'DONE' as const } : task,
    )
    view.rerender(
      <DagCanvas snapshot={after} grouping="phase" onGroupingChange={noop} onSelectTask={noop} />,
    )

    expect(positionsOf()).toEqual(first)
    expect(screen.getByTestId('task-node-T09').getAttribute('data-status')).toBe('DONE')
  })

  it('oferece a alternancia fase / onda / topologico', async () => {
    const onGroupingChange = vi.fn()
    render(
      <DagCanvas
        snapshot={makeSnapshot()}
        grouping="phase"
        onGroupingChange={onGroupingChange}
        onSelectTask={noop}
      />,
    )
    const porOnda = screen.getByRole('button', { name: 'por onda' })
    expect(screen.getByRole('button', { name: 'por fase' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    porOnda.click()
    expect(onGroupingChange).toHaveBeenCalledWith('wave')
  })
})

describe('acessibilidade do canvas', () => {
  it('cada no anuncia id, titulo, estado e fase sem depender de cor', () => {
    render(
      <DagCanvas
        snapshot={makeSnapshot()}
        grouping="phase"
        onGroupingChange={noop}
        onSelectTask={noop}
      />,
    )
    expect(screen.getByTestId('task-node-T09').getAttribute('aria-label')).toBe(
      'T09 Painel de propriedades — estado RUNNING, fase frontend',
    )
  })

  it('seleciona a task pelo teclado, com Enter sobre o no', () => {
    const onSelectTask = vi.fn()
    render(
      <DagCanvas
        snapshot={makeSnapshot()}
        grouping="phase"
        onGroupingChange={onSelectTask}
        onSelectTask={onSelectTask}
      />,
    )
    const wrapper = document.querySelector('[data-id="T09"]')
    expect(wrapper).not.toBeNull()
    if (wrapper !== null) fireEvent.keyDown(wrapper, { key: 'Enter' })
    expect(onSelectTask).toHaveBeenCalledWith('T09')
  })

  it('a aresta descreve a relacao em texto e marca o caminho critico', () => {
    const edges = buildEdges(makeSnapshot())
    const byId = new Map(edges.map((edge) => [edge.id, edge]))

    const satisfied = byId.get('T05->T09')
    expect(satisfied?.ariaLabel).toBe('T05 para T09: dependência satisfeita, caminho crítico')
    expect(satisfied?.className).toContain('dag-edge--satisfied')
    expect(satisfied?.className).toContain('dag-edge--critical')
    expect(satisfied?.style?.strokeWidth).toBe(3.5)

    const blocked = byId.get('T08->T14')
    expect(blocked?.ariaLabel).toBe('T08 para T14: destino bloqueado')
    expect(blocked?.className).toContain('dag-edge--blocked-target')

    const unsatisfied = byId.get('T09->T11')
    expect(unsatisfied?.ariaLabel).toContain('dependência não satisfeita')
    expect(edges).toHaveLength(makeSnapshot().graph.edges.length)
  })
})
