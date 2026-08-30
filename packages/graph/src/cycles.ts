import { rankOf, successorsOf } from './build.js'
import type { Cycle, Edge, Graph } from './types.js'

interface Frame {
  readonly node: string
  next: number
}

/**
 * Todos os componentes ciclicos do grafo (Tarjan SCC), cada um com um caminho fechado
 * concreto — `['T01', 'T02', 'T03', 'T01']`, nao "existe ciclo".
 *
 * Um componente com mais de um no, ou um no com auto-aresta, e ciclico. O caminho e o
 * menor ciclo elementar que passa pelo membro declarado primeiro, obtido por busca em
 * largura restrita ao componente: deterministico porque a adjacencia esta ordenada.
 */
export function findCycles(graph: Graph): readonly Cycle[] {
  const cycles: Cycle[] = []
  for (const component of stronglyConnectedComponents(graph)) {
    const members = [...component].sort((a, b) => rankOf(graph, a) - rankOf(graph, b))
    const root = members[0]
    if (root === undefined) continue
    const cyclic = members.length > 1 || successorsOf(graph, root).includes(root)
    if (!cyclic) continue
    cycles.push({ nodes: members, path: shortestClosedPath(graph, new Set(members), root) })
  }
  cycles.sort((a, b) => rankOf(graph, a.nodes[0] ?? '') - rankOf(graph, b.nodes[0] ?? ''))
  return cycles
}

/** Arestas `a -> a`, em ordem de declaracao do no. */
export function selfLoops(graph: Graph): readonly Edge[] {
  return graph.edges.filter((edge) => edge.from === edge.to)
}

/**
 * Tarjan iterativo — a pilha e explicita para que a profundidade do grafo nunca
 * dependa da pilha de chamadas do runtime.
 */
function stronglyConnectedComponents(graph: Graph): readonly (readonly string[])[] {
  const discovery = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  const open = (node: string): void => {
    discovery.set(node, counter)
    low.set(node, counter)
    counter += 1
    stack.push(node)
    onStack.add(node)
  }

  for (const root of graph.nodes) {
    if (discovery.has(root)) continue
    open(root)
    const work: Frame[] = [{ node: root, next: 0 }]

    while (work.length > 0) {
      const frame = work[work.length - 1]
      if (frame === undefined) break
      const successors = successorsOf(graph, frame.node)

      if (frame.next < successors.length) {
        const next = successors[frame.next]
        frame.next += 1
        if (next === undefined) continue
        if (!discovery.has(next)) {
          open(next)
          work.push({ node: next, next: 0 })
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, discovery.get(next) ?? 0))
        }
        continue
      }

      work.pop()
      const parent = work[work.length - 1]
      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0))
      }
      if (low.get(frame.node) === discovery.get(frame.node)) {
        const component: string[] = []
        for (;;) {
          const popped = stack.pop()
          if (popped === undefined) break
          onStack.delete(popped)
          component.push(popped)
          if (popped === frame.node) break
        }
        components.push(component)
      }
    }
  }
  return components
}

/** Menor caminho fechado que sai de `root` e volta a `root`, dentro do componente. */
function shortestClosedPath(graph: Graph, members: ReadonlySet<string>, root: string): string[] {
  const parent = new Map<string, string>()
  const visited = new Set<string>([root])
  const queue: string[] = [root]

  while (queue.length > 0) {
    const node = queue.shift()
    if (node === undefined) break
    for (const next of successorsOf(graph, node)) {
      if (!members.has(next)) continue
      if (next === root) return [...pathFromRoot(parent, root, node), root]
      if (visited.has(next)) continue
      visited.add(next)
      parent.set(next, node)
      queue.push(next)
    }
  }
  return [root, root]
}

function pathFromRoot(parent: ReadonlyMap<string, string>, root: string, tail: string): string[] {
  const path = [tail]
  let cursor = tail
  while (cursor !== root) {
    const previous = parent.get(cursor)
    if (previous === undefined) break
    path.push(previous)
    cursor = previous
  }
  return path.reverse()
}
