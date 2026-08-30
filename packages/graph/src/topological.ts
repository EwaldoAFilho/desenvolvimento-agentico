import { predecessorsOf, rankOf, successorsOf } from './build.js'
import type { Graph, TopologicalResult } from './types.js'

/**
 * Ordem topologica por Kahn. O desempate entre nos simultaneamente prontos e sempre
 * a ordem de declaracao — e o que garante que a mesma missao produza sempre o mesmo
 * plano. Grafo ciclico devolve `ok: false` com os nos que nunca ficaram prontos.
 */
export function topologicalOrder(graph: Graph): TopologicalResult {
  const remaining = new Map<string, number>()
  for (const node of graph.nodes) remaining.set(node, predecessorsOf(graph, node).length)

  // graph.nodes ja esta em ordem de declaracao: a fila nasce ordenada.
  const ready: string[] = graph.nodes.filter((node) => remaining.get(node) === 0)
  const order: string[] = []

  while (ready.length > 0) {
    const node = ready.shift()
    if (node === undefined) break
    order.push(node)
    for (const next of successorsOf(graph, node)) {
      const pending = (remaining.get(next) ?? 0) - 1
      remaining.set(next, pending)
      if (pending === 0) insertByRank(ready, next, graph)
    }
  }

  if (order.length === graph.nodes.length) return { ok: true, order }

  const emitted = new Set(order)
  return { ok: false, cycleNodes: graph.nodes.filter((node) => !emitted.has(node)) }
}

/** Insercao binaria mantendo a fila ordenada por indice de declaracao. */
function insertByRank(queue: string[], node: string, graph: Graph): void {
  const rank = rankOf(graph, node)
  let lo = 0
  let hi = queue.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const current = queue[mid]
    if (current !== undefined && rankOf(graph, current) < rank) lo = mid + 1
    else hi = mid
  }
  queue.splice(lo, 0, node)
}
