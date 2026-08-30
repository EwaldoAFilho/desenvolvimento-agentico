import type { FrozenGraph, TaskId, TaskSpec } from '@agentic/domain'
import { buildGraph, type Graph, longestPath, slack, waves } from '@agentic/graph'

const EMPTY: Graph = {
  nodes: [],
  edges: [],
  successors: new Map(),
  predecessors: new Map(),
  index: new Map(),
}

export const DEFAULT_ESTIMATE = 1

export interface GraphView {
  readonly graph: Graph
  readonly waves: readonly (readonly TaskId[])[]
  readonly criticalPath: readonly TaskId[]
  readonly slack: Record<string, number>
}

/** Geometria derivada do grafo CONGELADO do run: nunca recompila a missao. */
export function graphViewOf(frozen: FrozenGraph, weightOf?: (task: TaskSpec) => number): GraphView {
  const specs = new Map<string, TaskSpec>()
  for (const task of frozen.tasks) specs.set(task.id, task)
  const built = buildGraph(
    frozen.tasks.map((task) => task.id as string),
    frozen.edges.map((edge) => ({ from: edge.from as string, to: edge.to as string })),
  )
  const graph = built.ok ? built.graph : EMPTY
  const weight = (node: string): number => {
    const spec = specs.get(node)
    if (spec === undefined) return DEFAULT_ESTIMATE
    return weightOf === undefined ? (spec.estimate ?? DEFAULT_ESTIMATE) : weightOf(spec)
  }
  const slackByNode: Record<string, number> = {}
  for (const [node, value] of slack(graph, weight)) slackByNode[node] = value.slack
  return {
    graph,
    waves: waves(graph).map((wave) => wave.map((node) => node as TaskId)),
    criticalPath: longestPath(graph, weight).path.map((node) => node as TaskId),
    slack: slackByNode,
  }
}
