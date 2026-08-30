import { describe, expect, it } from 'vitest'
import {
  DIAMOND,
  DISCONNECTED,
  type GraphSpec,
  graphOf,
  LINEAR,
  MVP,
  mvpEstimate,
  SELF_LOOP,
  SIMPLE_CYCLE,
  TWO_CYCLES,
} from './__fixtures__/graphs.js'
import { buildGraph } from './build.js'
import { longestPath, slack, waves } from './critical-path.js'
import { findCycles, selfLoops } from './cycles.js'
import { concurrentPairs, transitiveClosure } from './reachability.js'
import { topologicalOrder } from './topological.js'
import type { Graph, Weight } from './types.js'

const RUNS = 25

/** Todas as analises do pacote em um unico valor comparavel. */
function analyze(graph: Graph, weight?: Weight): string {
  const folga = weight === undefined ? slack(graph) : slack(graph, weight)
  return JSON.stringify({
    nodes: graph.nodes,
    edges: graph.edges,
    successors: [...graph.successors],
    predecessors: [...graph.predecessors],
    topological: topologicalOrder(graph),
    cycles: findCycles(graph),
    selfLoops: selfLoops(graph),
    reachable: graph.nodes.map((node) => transitiveClosure(graph).reachable(node)),
    concurrent: concurrentPairs(graph),
    longest: weight === undefined ? longestPath(graph) : longestPath(graph, weight),
    slack: [...folga],
    waves: waves(graph),
  })
}

const CASES: readonly (readonly [string, GraphSpec])[] = [
  ['linear', LINEAR],
  ['diamante', DIAMOND],
  ['desconexo', DISCONNECTED],
  ['ciclo simples', SIMPLE_CYCLE],
  ['dois ciclos', TWO_CYCLES],
  ['auto-aresta', SELF_LOOP],
  ['missao', MVP],
]

describe('determinismo', () => {
  for (const [name, spec] of CASES) {
    it(`repete o mesmo resultado em ${RUNS} execucoes: ${name}`, () => {
      const esperado = analyze(graphOf(spec))
      for (let run = 0; run < RUNS; run += 1) {
        expect(analyze(graphOf(spec))).toBe(esperado)
      }
    })
  }

  it(`repete o mesmo resultado ponderado em ${RUNS} execucoes`, () => {
    const esperado = analyze(graphOf(MVP), mvpEstimate)
    for (let run = 0; run < RUNS; run += 1) {
      expect(analyze(graphOf(MVP), mvpEstimate)).toBe(esperado)
    }
  })

  it('independe da ordem em que as arestas foram declaradas', () => {
    const direto = analyze(graphOf(MVP), mvpEstimate)
    const invertido = buildGraph(MVP.nodes, [...MVP.edges].reverse())
    expect(invertido.ok).toBe(true)
    if (!invertido.ok) return
    expect(analyze(invertido.graph, mvpEstimate)).toBe(direto)
  })

  it('independe de arestas repetidas na entrada', () => {
    const direto = analyze(graphOf(MVP), mvpEstimate)
    const comRepetidas = buildGraph(MVP.nodes, [...MVP.edges, ...MVP.edges])
    expect(comRepetidas.ok).toBe(true)
    if (!comRepetidas.ok) return
    expect(analyze(comRepetidas.graph, mvpEstimate)).toBe(direto)
  })

  it('nao muta o grafo recebido', () => {
    const graph = graphOf(MVP)
    const antes = JSON.stringify({
      nodes: graph.nodes,
      edges: graph.edges,
      successors: [...graph.successors],
      predecessors: [...graph.predecessors],
      index: [...graph.index],
    })
    topologicalOrder(graph)
    findCycles(graph)
    transitiveClosure(graph)
    concurrentPairs(graph)
    longestPath(graph, mvpEstimate)
    slack(graph, mvpEstimate)
    waves(graph)
    selfLoops(graph)
    const depois = JSON.stringify({
      nodes: graph.nodes,
      edges: graph.edges,
      successors: [...graph.successors],
      predecessors: [...graph.predecessors],
      index: [...graph.index],
    })
    expect(depois).toBe(antes)
  })

  it('constroi grafos identicos a partir da mesma entrada', () => {
    const primeiro = buildGraph(MVP.nodes, MVP.edges)
    const segundo = buildGraph(MVP.nodes, MVP.edges)
    expect(primeiro.ok && segundo.ok).toBe(true)
    if (!primeiro.ok || !segundo.ok) return
    expect(analyze(segundo.graph, mvpEstimate)).toBe(analyze(primeiro.graph, mvpEstimate))
  })

  it('repete os mesmos erros estruturados para a mesma entrada invalida', () => {
    const invalida = () => buildGraph(['A', 'A', 'B'], [{ from: 'B', to: 'Z' }])
    const esperado = JSON.stringify(invalida())
    for (let run = 0; run < RUNS; run += 1) {
      expect(JSON.stringify(invalida())).toBe(esperado)
    }
  })
})
