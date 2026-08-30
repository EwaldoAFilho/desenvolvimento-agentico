import { describe, expect, it } from 'vitest'
import {
  DIAMOND,
  EMPTY,
  graphOf,
  LINEAR,
  MVP,
  SELF_LOOP,
  SIMPLE_CYCLE,
  TWO_CYCLES,
} from './__fixtures__/graphs.js'
import { buildGraph } from './build.js'
import { findCycles, selfLoops } from './cycles.js'

describe('findCycles', () => {
  it('nao encontra ciclo em cadeia linear', () => {
    expect(findCycles(graphOf(LINEAR))).toEqual([])
  })

  it('nao encontra ciclo no diamante', () => {
    expect(findCycles(graphOf(DIAMOND))).toEqual([])
  })

  it('nao encontra ciclo no grafo vazio', () => {
    expect(findCycles(graphOf(EMPTY))).toEqual([])
  })

  it('descreve o ciclo inteiro, nao apenas sua existencia', () => {
    const cycles = findCycles(graphOf(SIMPLE_CYCLE))
    expect(cycles).toHaveLength(1)
    expect(cycles[0]?.path).toEqual(['A', 'B', 'C', 'A'])
    expect(cycles[0]?.nodes).toEqual(['A', 'B', 'C'])
  })

  it('descreve cada ciclo disjunto separadamente', () => {
    const cycles = findCycles(graphOf(TWO_CYCLES))
    expect(cycles.map((cycle) => cycle.path)).toEqual([
      ['A', 'B', 'A'],
      ['C', 'D', 'C'],
    ])
  })

  it('descreve auto-aresta como ciclo de um no', () => {
    const cycles = findCycles(graphOf(SELF_LOOP))
    expect(cycles).toEqual([{ nodes: ['A'], path: ['A', 'A'] }])
  })

  it('reporta um componente com corda como um unico ciclo com todos os membros', () => {
    const built = buildGraph(
      ['A', 'B', 'C'],
      [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
        { from: 'C', to: 'A' },
        { from: 'C', to: 'B' },
      ],
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const cycles = findCycles(built.graph)
    expect(cycles).toHaveLength(1)
    expect(cycles[0]?.nodes).toEqual(['A', 'B', 'C'])
    expect(cycles[0]?.path).toEqual(['A', 'B', 'C', 'A'])
  })

  it('ordena os ciclos pela declaracao do no de entrada', () => {
    const built = buildGraph(
      ['A', 'B', 'C', 'D'],
      [
        { from: 'C', to: 'D' },
        { from: 'D', to: 'C' },
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' },
      ],
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(findCycles(built.graph).map((cycle) => cycle.nodes[0])).toEqual(['A', 'C'])
  })

  it('confirma que o DAG da missao nao tem ciclo', () => {
    expect(findCycles(graphOf(MVP))).toEqual([])
  })
})

describe('selfLoops', () => {
  it('lista a aresta a -> a', () => {
    expect(selfLoops(graphOf(SELF_LOOP))).toEqual([{ from: 'A', to: 'A' }])
  })

  it('nao acusa auto-aresta em grafo sem ela', () => {
    expect(selfLoops(graphOf(DIAMOND))).toEqual([])
    expect(selfLoops(graphOf(SIMPLE_CYCLE))).toEqual([])
  })

  it('lista varias auto-arestas em ordem de declaracao do no', () => {
    const built = buildGraph(
      ['A', 'B', 'C'],
      [
        { from: 'C', to: 'C' },
        { from: 'A', to: 'A' },
        { from: 'A', to: 'B' },
      ],
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(selfLoops(built.graph)).toEqual([
      { from: 'A', to: 'A' },
      { from: 'C', to: 'C' },
    ])
  })
})
