import { successorsOf } from './build.js'
import type { ConcurrentPair, Graph, Reachability } from './types.js'

/**
 * Fecho transitivo. `reaches(a, b)` e verdadeiro quando existe caminho de pelo menos
 * uma aresta de `a` ate `b` — logo `reaches(a, a)` so e verdadeiro se `a` esta em ciclo.
 */
export function transitiveClosure(graph: Graph): Reachability {
  const sets = new Map<string, ReadonlySet<string>>()
  for (const node of graph.nodes) sets.set(node, descendants(graph, node))

  return {
    reaches: (from, to) => sets.get(from)?.has(to) ?? false,
    reachable: (from) => {
      const set = sets.get(from)
      return set === undefined ? [] : graph.nodes.filter((node) => set.has(node))
    },
  }
}

/**
 * Pares sem relacao de ordem em nenhuma direcao: o que pode, estruturalmente, rodar
 * junto. Cada par sai como `[a, b]` na ordem de declaracao, e a lista inteira tambem.
 */
export function concurrentPairs(graph: Graph): readonly ConcurrentPair[] {
  const closure = transitiveClosure(graph)
  const pairs: ConcurrentPair[] = []
  for (let i = 0; i < graph.nodes.length; i += 1) {
    const a = graph.nodes[i]
    if (a === undefined) continue
    for (let j = i + 1; j < graph.nodes.length; j += 1) {
      const b = graph.nodes[j]
      if (b === undefined) continue
      if (!closure.reaches(a, b) && !closure.reaches(b, a)) pairs.push([a, b])
    }
  }
  return pairs
}

/** Busca em profundidade iterativa; o proprio no so entra se um ciclo o devolver. */
function descendants(graph: Graph, start: string): ReadonlySet<string> {
  const found = new Set<string>()
  const stack = [...successorsOf(graph, start)]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    if (found.has(node)) continue
    found.add(node)
    for (const next of successorsOf(graph, node)) if (!found.has(next)) stack.push(next)
  }
  return found
}
