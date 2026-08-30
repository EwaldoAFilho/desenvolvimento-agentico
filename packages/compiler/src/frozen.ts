import type { FrozenGraph } from '@agentic/domain'
import type { CompiledGraph } from './types.js'

/**
 * Forma minima que o dominio congela no Run (DOMAIN-MODEL 3.1): editar o YAML durante a
 * execucao nao muda o run corrente (ADR-0005). As analises ficam no CompiledGraph, que o
 * dashboard e o relatorio consomem sem recompilar.
 */
export function toFrozenGraph(graph: CompiledGraph): FrozenGraph {
  return {
    specHash: graph.specHash,
    tasks: graph.nodes.map((node) => node.task),
    edges: graph.edges,
    topologicalOrder: graph.topologicalOrder,
  }
}
