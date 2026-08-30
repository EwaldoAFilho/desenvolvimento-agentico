import type { GraphEdgeDto, RunGraphDto } from '@agentic/schemas'
import { isDependencySatisfied, type TaskStatus } from './status.js'

/**
 * Aresta: cinza (dependencia nao satisfeita), verde (satisfeita), ambar tracejada (destino
 * bloqueado). Caminho critico com traco mais espesso (DASHBOARD 3).
 */
export type EdgeKind = 'unsatisfied' | 'satisfied' | 'blocked-target'

export const EDGE_LABEL: Record<EdgeKind, string> = {
  unsatisfied: 'dependência não satisfeita',
  satisfied: 'dependência satisfeita',
  'blocked-target': 'destino bloqueado',
}

export function classifyEdge(from: TaskStatus, to: TaskStatus): EdgeKind {
  if (to === 'BLOCKED') return 'blocked-target'
  return isDependencySatisfied(from) ? 'satisfied' : 'unsatisfied'
}

/** Pares consecutivos do caminho critico vindo do contrato — nada e recalculado aqui. */
export function criticalPathEdges(graph: RunGraphDto): ReadonlySet<string> {
  const keys = new Set<string>()
  for (let i = 0; i + 1 < graph.criticalPath.length; i += 1) {
    keys.add(edgeKey({ from: graph.criticalPath[i] ?? '', to: graph.criticalPath[i + 1] ?? '' }))
  }
  return keys
}

export function edgeKey(edge: GraphEdgeDto): string {
  return `${edge.from}->${edge.to}`
}
