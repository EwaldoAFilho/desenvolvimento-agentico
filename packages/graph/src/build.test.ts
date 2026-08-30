import { describe, expect, it } from 'vitest'
import { DIAMOND, DISCONNECTED, EMPTY, graphOf, LINEAR, SELF_LOOP } from './__fixtures__/graphs.js'
import { buildGraph, predecessorsOf, rankOf, successorsOf } from './build.js'

describe('buildGraph', () => {
  it('preserva a ordem de declaracao dos nos', () => {
    const graph = graphOf(DISCONNECTED)
    expect(graph.nodes).toEqual(['A', 'B', 'X', 'Y', 'Z'])
    expect(rankOf(graph, 'X')).toBe(2)
    expect(rankOf(graph, 'inexistente')).toBe(-1)
  })

  it('monta sucessores e predecessores', () => {
    const graph = graphOf(DIAMOND)
    expect(successorsOf(graph, 'A')).toEqual(['B', 'C'])
    expect(successorsOf(graph, 'D')).toEqual([])
    expect(predecessorsOf(graph, 'D')).toEqual(['B', 'C'])
    expect(predecessorsOf(graph, 'A')).toEqual([])
  })

  it('ordena a adjacencia por declaracao, independente da ordem das arestas', () => {
    const direct = buildGraph(DIAMOND.nodes, DIAMOND.edges)
    const shuffled = buildGraph(DIAMOND.nodes, [...DIAMOND.edges].reverse())
    expect(direct.ok && shuffled.ok).toBe(true)
    if (!direct.ok || !shuffled.ok) return
    expect(successorsOf(shuffled.graph, 'A')).toEqual(['B', 'C'])
    expect(shuffled.graph.edges).toEqual(direct.graph.edges)
  })

  it('constroi grafo vazio', () => {
    const graph = graphOf(EMPTY)
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
  })

  it('reporta no desconhecido no destino da aresta como erro estruturado', () => {
    const result = buildGraph(['A'], [{ from: 'A', to: 'Z' }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toEqual([
      {
        code: 'UNKNOWN_NODE',
        node: 'Z',
        edge: { from: 'A', to: 'Z' },
        endpoint: 'to',
        message: 'aresta referencia no inexistente: A precede Z',
      },
    ])
  })

  it('reporta no desconhecido na origem da aresta', () => {
    const result = buildGraph(['A'], [{ from: 'Z', to: 'A' }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.code).toBe('UNKNOWN_NODE')
    expect(result.errors[0]?.node).toBe('Z')
  })

  it('reporta os dois extremos quando ambos sao desconhecidos', () => {
    const result = buildGraph(['A'], [{ from: 'Y', to: 'Z' }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((error) => error.node)).toEqual(['Y', 'Z'])
  })

  it('nao lanca diante de entrada invalida', () => {
    expect(() =>
      buildGraph(
        ['A', 'A'],
        [
          { from: 'Z', to: 'Z' },
          { from: 'A', to: 'Q' },
        ],
      ),
    ).not.toThrow()
  })

  it('reporta no declarado duas vezes', () => {
    const result = buildGraph(['A', 'B', 'A'], [])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toEqual([
      { code: 'DUPLICATE_NODE', node: 'A', message: 'no declarado mais de uma vez: A' },
    ])
  })

  it('colapsa arestas repetidas', () => {
    const result = buildGraph(
      ['A', 'B'],
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'B' },
      ],
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.graph.edges).toEqual([{ from: 'A', to: 'B' }])
    expect(successorsOf(result.graph, 'A')).toEqual(['B'])
    expect(predecessorsOf(result.graph, 'B')).toEqual(['A'])
  })

  it('preserva auto-aresta em vez de tratar como erro', () => {
    const graph = graphOf(SELF_LOOP)
    expect(graph.edges).toEqual([
      { from: 'A', to: 'A' },
      { from: 'A', to: 'B' },
    ])
    expect(successorsOf(graph, 'A')).toEqual(['A', 'B'])
    expect(predecessorsOf(graph, 'A')).toEqual(['A'])
  })

  it('devolve listas vazias para no fora do grafo', () => {
    const graph = graphOf(LINEAR)
    expect(successorsOf(graph, 'inexistente')).toEqual([])
    expect(predecessorsOf(graph, 'inexistente')).toEqual([])
  })
})
