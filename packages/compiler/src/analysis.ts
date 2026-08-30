import {
  type Dependency,
  findPathScopeConflicts,
  type MissionSpec,
  type TaskId,
  type TaskSpec,
} from '@agentic/domain'
import {
  buildGraph,
  type Cycle,
  concurrentPairs,
  type Edge,
  findCycles,
  type Graph,
  longestPath,
  successorsOf,
  topologicalOrder,
  waves,
} from '@agentic/graph'
import type { ConcurrentTaskPair, CriticalPath, TouchConflict } from './types.js'

/** Peso default de uma task no caminho critico (MISSION-FORMAT 1.2). */
export const DEFAULT_ESTIMATE = 1

export interface Analysis {
  readonly graph: Graph
  readonly tasksById: ReadonlyMap<string, TaskSpec>
  readonly edges: readonly Dependency[]
  readonly cycles: readonly Cycle[]
  /** Vazia quando ha ciclo: sem ordem topologica nao existe plano. */
  readonly topological: readonly TaskId[]
  readonly waves: readonly (readonly TaskId[])[]
  readonly depth: ReadonlyMap<string, number>
  readonly criticalPath: CriticalPath
  readonly concurrent: readonly ConcurrentTaskPair[]
  readonly dependents: (task: TaskId) => readonly TaskId[]
}

const asTaskId = (id: string): TaskId => id as TaskId

/**
 * As arestas entram saneadas: id duplicado, dependencia inexistente e auto-dependencia ja
 * viraram ERROR na validacao semantica, e mante-las aqui so impediria as demais analises
 * de rodar — o relatorio ficaria pior, nao melhor.
 */
function sanitizedEdges(spec: MissionSpec, known: ReadonlySet<string>): Dependency[] {
  const edges: Dependency[] = []
  const seen = new Set<string>()
  for (const task of spec.tasks) {
    if (!known.has(task.id)) continue
    for (const dependency of task.dependencies) {
      if (!known.has(dependency) || dependency === task.id) continue
      const key = `${dependency} ${task.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: dependency, to: task.id })
    }
  }
  return edges
}

export function analyze(spec: MissionSpec): Analysis {
  const tasksById = new Map<string, TaskSpec>()
  const nodes: string[] = []
  for (const task of spec.tasks) {
    if (tasksById.has(task.id)) continue
    tasksById.set(task.id, task)
    nodes.push(task.id)
  }

  const dependencies = sanitizedEdges(spec, new Set(nodes))
  const edges: Edge[] = dependencies.map((edge) => ({ from: edge.from, to: edge.to }))
  const built = buildGraph(nodes, edges)
  const graph: Graph = built.ok
    ? built.graph
    : { nodes: [], edges: [], successors: new Map(), predecessors: new Map(), index: new Map() }

  const weight = (node: string): number => tasksById.get(node)?.estimate ?? DEFAULT_ESTIMATE
  const order = topologicalOrder(graph)
  const grouped = waves(graph)
  const depth = new Map<string, number>()
  grouped.forEach((wave, level) => {
    for (const node of wave) depth.set(node, level)
  })
  const critical = longestPath(graph, weight)

  return {
    graph,
    tasksById,
    edges: dependencies,
    cycles: findCycles(graph),
    topological: order.ok ? order.order.map(asTaskId) : [],
    waves: grouped.map((wave) => wave.map(asTaskId)),
    depth,
    criticalPath: { tasks: critical.path.map(asTaskId), length: critical.length },
    concurrent: concurrentPairs(graph).map(([a, b]) => [asTaskId(a), asTaskId(b)]),
    dependents: (task) => successorsOf(graph, task).map(asTaskId),
  }
}

/**
 * Pares concorrentes cujos escopos de escrita se sobrepoem. Nao e o mesmo que violar I2:
 * o scheduler nunca despacha o par junto — isto avisa que o plano depende dessa serializacao
 * forcada, o que costuma ser um erro de granularidade.
 */
export function touchConflictsOf(analysis: Analysis): TouchConflict[] {
  const conflicts: TouchConflict[] = []
  for (const pair of analysis.concurrent) {
    const left = analysis.tasksById.get(pair[0])
    const right = analysis.tasksById.get(pair[1])
    if (left === undefined || right === undefined) continue
    const paths = findPathScopeConflicts(left.touches, right.touches)
    if (paths.length > 0) conflicts.push({ tasks: pair, paths })
  }
  return conflicts
}

/** Maior wave: quantos executores o plano consegue ocupar no melhor momento. */
export function maxParallelism(analysis: Analysis): number {
  return analysis.waves.reduce((max, wave) => Math.max(max, wave.length), 0)
}
