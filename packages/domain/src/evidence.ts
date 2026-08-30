import { isPathInAnyScope, outOfScopePaths, type PathScope } from './path-scope.js'

export const EVIDENCE_KINDS = ['scope', 'gate', 'review', 'integration'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

/**
 * Evidencia nao e tabela paralela: e a visao citavel sobre Observation, GateExecution e
 * Review (DOMAIN-MODEL 3.8).
 */
export interface EvidenceRef {
  readonly kind: EvidenceKind
  readonly sourceId: string
  readonly artifactPath?: string
  readonly digest: string
}

export function hasEvidenceOfKind(refs: readonly EvidenceRef[], kind: EvidenceKind): boolean {
  return refs.some((ref) => ref.kind === kind)
}

export type ScopeCheck = 'PASS' | 'VIOLATION'

export type FileChangeKind = 'A' | 'M' | 'D' | 'R' | 'C' | 'T'

export interface FileChange {
  readonly path: string
  readonly change: FileChangeKind
  readonly added: number
  readonly removed: number
  readonly renamedFrom?: string
}

export interface DiffStat {
  readonly files: number
  readonly added: number
  readonly removed: number
}

/**
 * O contraponto factual do `claims`: produzida pelo control plane a partir do diff medido
 * por nos (P05).
 */
export interface Observation {
  readonly filesChanged: readonly FileChange[]
  readonly diffStat: DiffStat
  readonly diffRef?: string
  readonly outOfScopePaths: readonly string[]
  readonly commit?: string
  readonly scopeCheck: ScopeCheck
}

export function diffStatOf(changes: readonly FileChange[]): DiffStat {
  let added = 0
  let removed = 0
  for (const change of changes) {
    added += change.added
    removed += change.removed
  }
  return { files: changes.length, added, removed }
}

export interface ScopeEvaluation {
  readonly scopeCheck: ScopeCheck
  readonly outOfScopePaths: readonly string[]
}

/** P04: escopo declarado e contrato. Caminho fora de `touches` ou dentro de `denyPaths` reprova. */
export function evaluateScope(
  paths: readonly string[],
  touches: readonly PathScope[],
  denied: readonly PathScope[] = [],
): ScopeEvaluation {
  const offending = outOfScopePaths(paths, touches, denied)
  return { scopeCheck: offending.length === 0 ? 'PASS' : 'VIOLATION', outOfScopePaths: offending }
}

export function observe(
  changes: readonly FileChange[],
  touches: readonly PathScope[],
  denied: readonly PathScope[] = [],
): Observation {
  const evaluation = evaluateScope(
    changes.map((change) => change.path),
    touches,
    denied,
  )
  return {
    filesChanged: changes,
    diffStat: diffStatOf(changes),
    outOfScopePaths: evaluation.outOfScopePaths,
    scopeCheck: evaluation.scopeCheck,
  }
}

export function isReadAllowed(path: string, reads: readonly PathScope[]): boolean {
  return isPathInAnyScope(path, reads)
}
