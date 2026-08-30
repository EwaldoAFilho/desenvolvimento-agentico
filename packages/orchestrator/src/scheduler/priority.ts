import { DEFAULT_ESTIMATE } from '@agentic/compiler'
import type { FrozenGraph, Risk, TaskId, TaskSpec } from '@agentic/domain'
import { buildGraph, type Graph, longestPath, successorsOf } from '@agentic/graph'

const EMPTY_GRAPH: Graph = {
  nodes: [],
  edges: [],
  successors: new Map(),
  predecessors: new Map(),
  index: new Map(),
}

/** Risco alto primeiro (criterio c). Spec ausente cai em `medium`. */
const RISK_RANK: Readonly<Record<Risk, number>> = { high: 0, medium: 1, low: 2 }

/**
 * Indices derivados do grafo congelado. Tudo que ordena decisao vem daqui — nunca da
 * ordem do array `tasks` — e por isso embaralhar a entrada nao muda a saida.
 */
export interface GraphPlan {
  readonly specOf: (task: TaskId) => TaskSpec | undefined
  readonly isCritical: (task: TaskId) => boolean
  readonly dependentsOf: (task: TaskId) => number
  readonly topoIndexOf: (task: TaskId) => number
}

export function buildPlan(graph: FrozenGraph, specs: ReadonlyMap<TaskId, TaskSpec>): GraphPlan {
  const byId = new Map<TaskId, TaskSpec>()
  for (const task of graph.tasks) if (!byId.has(task.id)) byId.set(task.id, task)
  for (const [id, spec] of specs) byId.set(id, spec)

  const nodes = graph.tasks.map((task) => task.id)
  const built = buildGraph(
    nodes,
    graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
  )
  const compiled = built.ok ? built.graph : EMPTY_GRAPH

  const weight = (node: string): number => byId.get(node as TaskId)?.estimate ?? DEFAULT_ESTIMATE
  const critical = new Set<string>(longestPath(compiled, weight).path)

  // Ordem canonica: a topologica congelada no Run. O que nao estiver nela vai para o fim,
  // preservando a ordem de declaracao.
  const topo = new Map<string, number>()
  graph.topologicalOrder.forEach((task, position) => {
    if (!topo.has(task)) topo.set(task, position)
  })
  const overflow = graph.topologicalOrder.length
  graph.tasks.forEach((task, position) => {
    if (!topo.has(task.id)) topo.set(task.id, overflow + position)
  })

  return {
    specOf: (task) => byId.get(task),
    isCritical: (task) => critical.has(task),
    dependentsOf: (task) => successorsOf(compiled, task).length,
    topoIndexOf: (task) => topo.get(task) ?? Number.MAX_SAFE_INTEGER,
  }
}

/**
 * Ordem obrigatoria (ARCHITECTURE 3.2, item 6): (a) caminho critico, (b) numero de
 * dependentes destravados, (c) risco alto primeiro, (d) ordem topologica canonica.
 * O id fecha o desempate para que a ordem seja total mesmo com grafo degenerado.
 */
export function comparePriority(plan: GraphPlan, a: TaskId, b: TaskId): number {
  const criticalDelta = Number(plan.isCritical(b)) - Number(plan.isCritical(a))
  if (criticalDelta !== 0) return criticalDelta

  const dependentsDelta = plan.dependentsOf(b) - plan.dependentsOf(a)
  if (dependentsDelta !== 0) return dependentsDelta

  const riskDelta = riskRankOf(plan, a) - riskRankOf(plan, b)
  if (riskDelta !== 0) return riskDelta

  const topoDelta = plan.topoIndexOf(a) - plan.topoIndexOf(b)
  if (topoDelta !== 0) return topoDelta

  return a < b ? -1 : a > b ? 1 : 0
}

function riskRankOf(plan: GraphPlan, task: TaskId): number {
  const risk = plan.specOf(task)?.risk
  return risk === undefined ? RISK_RANK.medium : RISK_RANK[risk]
}

/** Ordena sem mutar a entrada: a lista recebida e do chamador. */
export function sortByPriority<T>(
  plan: GraphPlan,
  items: readonly T[],
  taskOf: (item: T) => TaskId,
): T[] {
  return [...items].sort((a, b) => comparePriority(plan, taskOf(a), taskOf(b)))
}
