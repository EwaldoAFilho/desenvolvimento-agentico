export const PACKAGE_NAME = '@agentic/graph'

export { buildGraph, predecessorsOf, rankOf, successorsOf } from './build.js'
export { longestPath, slack, waves } from './critical-path.js'
export { findCycles, selfLoops } from './cycles.js'
export { concurrentPairs, transitiveClosure } from './reachability.js'
export { topologicalOrder } from './topological.js'
export type {
  BuildResult,
  ConcurrentPair,
  Cycle,
  Edge,
  Graph,
  GraphError,
  LongestPath,
  NodeSlack,
  Reachability,
  TopologicalResult,
  Weight,
} from './types.js'
