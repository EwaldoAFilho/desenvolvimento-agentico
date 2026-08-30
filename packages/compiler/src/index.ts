export const PACKAGE_NAME = '@agentic/compiler'

export {
  type Analysis,
  analyze,
  DEFAULT_ESTIMATE,
  maxParallelism,
  touchConflictsOf,
} from './analysis.js'
export {
  type CatalogEntry,
  DIAGNOSTIC_CATALOG,
  hintOf,
  isDiagnosticCode,
  severityOf,
} from './catalog.js'
export { compiledTasks, compileMission, totalWork } from './compile.js'
export {
  bySeverity,
  codesOf,
  type DiagnosticInput,
  diagnostic,
  findDiagnostic,
  hasError,
  sortDiagnostics,
} from './diagnostics.js'
export { toFrozenGraph } from './frozen.js'
export { canonicalJson, canonicalSpec, fnv1a64, SPEC_HASH_ALGORITHM, specHashOf } from './hash.js'
export { HEURISTICS } from './heuristics.js'
export { deniedBy, isTopLevelDirectory } from './paths.js'
export { fieldTarget, type SourceKind } from './sources.js'
export {
  type CompiledGraph,
  type CompiledNode,
  type CompileInput,
  type CompileResult,
  type ConcurrentTaskPair,
  type CriticalPath,
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticCode,
  type TouchConflict,
} from './types.js'
