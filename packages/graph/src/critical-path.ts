import { predecessorsOf, successorsOf } from './build.js'
import { topologicalOrder } from './topological.js'
import type { Graph, LongestPath, NodeSlack, Weight } from './types.js'

const UNIT: Weight = () => 1

/**
 * Caminho mais longo ponderado pelo peso dos nos — o caminho critico do plano.
 *
 * Requer grafo aciclico: com ciclo o valor nao existe, e a funcao devolve
 * `{ length: 0, path: [] }` em vez de lancar (ciclo e diagnostico do compilador).
 * Empate resolve pelo predecessor declarado primeiro e, no fim do caminho, pelo no
 * declarado primeiro.
 */
export function longestPath(graph: Graph, weight: Weight = UNIT): LongestPath {
  const topological = topologicalOrder(graph)
  if (!topological.ok) return { length: 0, path: [] }

  const best = new Map<string, number>()
  const cameFrom = new Map<string, string>()

  for (const node of topological.order) {
    let chosen: string | undefined
    let inherited = 0
    for (const predecessor of predecessorsOf(graph, node)) {
      const value = best.get(predecessor) ?? 0
      if (chosen === undefined || value > inherited) {
        chosen = predecessor
        inherited = value
      }
    }
    best.set(node, inherited + weight(node))
    if (chosen !== undefined) cameFrom.set(node, chosen)
  }

  let end: string | undefined
  let length = 0
  for (const node of graph.nodes) {
    const value = best.get(node) ?? 0
    if (end === undefined || value > length) {
      end = node
      length = value
    }
  }
  if (end === undefined) return { length: 0, path: [] }

  const path: string[] = []
  let cursor: string | undefined = end
  while (cursor !== undefined) {
    path.push(cursor)
    cursor = cameFrom.get(cursor)
  }
  return { length, path: path.reverse() }
}

/**
 * Early/late start e finish por no, e a folga `ls - es`. Folga zero e caminho critico.
 * Grafo ciclico devolve mapa vazio, pela mesma razao de `longestPath`.
 * O mapa itera em ordem de declaracao.
 */
export function slack(graph: Graph, weight: Weight = UNIT): ReadonlyMap<string, NodeSlack> {
  const result = new Map<string, NodeSlack>()
  const topological = topologicalOrder(graph)
  if (!topological.ok) return result

  const es = new Map<string, number>()
  const ef = new Map<string, number>()
  for (const node of topological.order) {
    let start = 0
    for (const predecessor of predecessorsOf(graph, node)) {
      start = Math.max(start, ef.get(predecessor) ?? 0)
    }
    es.set(node, start)
    ef.set(node, start + weight(node))
  }

  let projectEnd = 0
  for (const node of graph.nodes) projectEnd = Math.max(projectEnd, ef.get(node) ?? 0)

  const ls = new Map<string, number>()
  const lf = new Map<string, number>()
  for (let i = topological.order.length - 1; i >= 0; i -= 1) {
    const node = topological.order[i]
    if (node === undefined) continue
    let finish = projectEnd
    for (const successor of successorsOf(graph, node)) {
      finish = Math.min(finish, ls.get(successor) ?? projectEnd)
    }
    lf.set(node, finish)
    ls.set(node, finish - weight(node))
  }

  for (const node of graph.nodes) {
    const nodeEs = es.get(node) ?? 0
    const nodeLs = ls.get(node) ?? 0
    result.set(node, {
      es: nodeEs,
      ef: ef.get(node) ?? 0,
      ls: nodeLs,
      lf: lf.get(node) ?? 0,
      slack: nodeLs - nodeEs,
    })
  }
  return result
}

/**
 * Agrupamento por earliest start em numero de arestas (profundidade): a onda de um no
 * e a maior distancia ate uma origem. Visualizacao do plano, nao o modelo do scheduler.
 * Cada onda sai em ordem de declaracao; grafo ciclico devolve lista vazia.
 */
export function waves(graph: Graph): readonly (readonly string[])[] {
  const topological = topologicalOrder(graph)
  if (!topological.ok) return []

  const depth = new Map<string, number>()
  for (const node of topological.order) {
    let level = 0
    for (const predecessor of predecessorsOf(graph, node)) {
      level = Math.max(level, (depth.get(predecessor) ?? 0) + 1)
    }
    depth.set(node, level)
  }

  const grouped: string[][] = []
  for (const node of graph.nodes) {
    const level = depth.get(node) ?? 0
    while (grouped.length <= level) grouped.push([])
    const wave = grouped[level]
    if (wave !== undefined) wave.push(node)
  }
  return grouped
}
