import { describe, expect, it } from 'vitest'
import {
  DIAMOND,
  DISCONNECTED,
  EMPTY,
  graphOf,
  LINEAR,
  MVP,
  SELF_LOOP,
  SIMPLE_CYCLE,
  SINGLE,
  TWO_CYCLES,
} from './__fixtures__/graphs.js'
import { buildGraph, predecessorsOf } from './build.js'
import { topologicalOrder } from './topological.js'

describe('topologicalOrder', () => {
  it('ordena cadeia linear', () => {
    const result = topologicalOrder(graphOf(LINEAR))
    expect(result).toEqual({ ok: true, order: ['A', 'B', 'C', 'D'] })
  })

  it('desempata pela ordem de declaracao no diamante', () => {
    const result = topologicalOrder(graphOf(DIAMOND))
    expect(result).toEqual({ ok: true, order: ['A', 'B', 'C', 'D'] })
  })

  it('nao depende da ordem em que as arestas foram declaradas', () => {
    const built = buildGraph(DIAMOND.nodes, [...DIAMOND.edges].reverse())
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(topologicalOrder(built.graph)).toEqual({ ok: true, order: ['A', 'B', 'C', 'D'] })
  })

  it('intercala componentes desconexos pela declaracao', () => {
    const result = topologicalOrder(graphOf(DISCONNECTED))
    expect(result).toEqual({ ok: true, order: ['A', 'B', 'X', 'Y', 'Z'] })
  })

  it('aceita grafo vazio', () => {
    expect(topologicalOrder(graphOf(EMPTY))).toEqual({ ok: true, order: [] })
  })

  it('aceita no unico', () => {
    expect(topologicalOrder(graphOf(SINGLE))).toEqual({ ok: true, order: ['A'] })
  })

  it('falha com ciclo simples e lista os nos travados', () => {
    const result = topologicalOrder(graphOf(SIMPLE_CYCLE))
    expect(result).toEqual({ ok: false, cycleNodes: ['A', 'B', 'C'] })
  })

  it('emite o que e alcancavel e trava so no que depende dos dois ciclos', () => {
    const result = topologicalOrder(graphOf(TWO_CYCLES))
    expect(result).toEqual({ ok: false, cycleNodes: ['A', 'B', 'C', 'D'] })
  })

  it('trata auto-aresta como ciclo', () => {
    const result = topologicalOrder(graphOf(SELF_LOOP))
    expect(result).toEqual({ ok: false, cycleNodes: ['A', 'B'] })
  })

  it('produz extensao linear valida do DAG da missao', () => {
    const graph = graphOf(MVP)
    const result = topologicalOrder(graph)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.order).toHaveLength(graph.nodes.length)
    const position = new Map(result.order.map((node, at) => [node, at]))
    for (const node of graph.nodes) {
      for (const predecessor of predecessorsOf(graph, node)) {
        expect(position.get(predecessor) ?? -1).toBeLessThan(position.get(node) ?? -1)
      }
    }
  })

  it('escolhe o menor indice de declaracao entre os prontos na missao', () => {
    // A tabela de tasks ja esta declarada em ordem topologica: o desempate por
    // declaracao devolve exatamente a ordem do documento.
    const result = topologicalOrder(graphOf(MVP))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.order).toEqual(MVP.nodes)
  })
})
