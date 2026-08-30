import { InvalidPathScopeError } from './errors.js'
import type { Brand } from './ids.js'

/**
 * Caminho POSIX relativo a raiz do repositorio, normalizado. Terminado em `/` e prefixo de
 * diretorio; caso contrario e arquivo especifico. Sem globs (MISSION-FORMAT 1.3).
 */
export type PathScope = Brand<string, 'PathScope'>

export type PathScopeKind = 'directory' | 'file'

const GLOB_CHARS = /[*?[\]{}]/
const WINDOWS_DRIVE = /^[A-Za-z]:/

function normalize(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidPathScopeError(raw, 'nao e string')
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new InvalidPathScopeError(raw, 'caminho vazio')
  if (trimmed.includes('\\')) throw new InvalidPathScopeError(raw, 'somente separador POSIX')
  if (GLOB_CHARS.test(trimmed)) throw new InvalidPathScopeError(raw, 'glob nao suportado')
  if (trimmed.startsWith('/') || WINDOWS_DRIVE.test(trimmed)) {
    throw new InvalidPathScopeError(raw, 'caminho absoluto')
  }
  const segments = trimmed.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.includes('..')) throw new InvalidPathScopeError(raw, '".." nao e permitido')
  if (segments.length === 0) throw new InvalidPathScopeError(raw, 'caminho vazio apos normalizar')
  return trimmed.endsWith('/') ? `${segments.join('/')}/` : segments.join('/')
}

export function pathScope(raw: string): PathScope {
  return normalize(raw) as PathScope
}

export function tryPathScope(raw: string): PathScope | undefined {
  try {
    return pathScope(raw)
  } catch {
    return undefined
  }
}

export function isPathScope(raw: unknown): raw is PathScope {
  try {
    normalize(raw)
    return true
  } catch {
    return false
  }
}

export function pathScopeKind(scope: PathScope): PathScopeKind {
  return scope.endsWith('/') ? 'directory' : 'file'
}

export function pathScopeSegments(scope: PathScope): string[] {
  return scope.split('/').filter((segment) => segment.length > 0)
}

function isSegmentPrefix(shorter: readonly string[], longer: readonly string[]): boolean {
  for (let i = 0; i < shorter.length; i += 1) {
    if (shorter[i] !== longer[i]) return false
  }
  return true
}

/**
 * "A conflita com B se um e prefixo do outro" — comparado em fronteira de segmento, para que
 * `src/a.ts` nao conflite com `src/a.tsx`.
 */
export function pathScopesConflict(a: PathScope, b: PathScope): boolean {
  const left = pathScopeSegments(a)
  const right = pathScopeSegments(b)
  return left.length <= right.length ? isSegmentPrefix(left, right) : isSegmentPrefix(right, left)
}

export interface PathScopeConflict {
  readonly left: PathScope
  readonly right: PathScope
}

export function findPathScopeConflicts(
  a: readonly PathScope[],
  b: readonly PathScope[],
): PathScopeConflict[] {
  const conflicts: PathScopeConflict[] = []
  for (const left of a) {
    for (const right of b) {
      if (pathScopesConflict(left, right)) conflicts.push({ left, right })
    }
  }
  return conflicts
}

export function pathScopeSetsConflict(a: readonly PathScope[], b: readonly PathScope[]): boolean {
  return findPathScopeConflicts(a, b).length > 0
}

/** Um caminho alterado esta dentro do escopo? Arquivo exige igualdade; diretorio, prefixo. */
export function isPathInScope(path: string, scope: PathScope): boolean {
  const candidate = tryPathScope(path)
  if (candidate === undefined) return false
  const file = pathScopeSegments(candidate)
  const allowed = pathScopeSegments(scope)
  if (pathScopeKind(scope) === 'file') {
    return file.length === allowed.length && isSegmentPrefix(allowed, file)
  }
  return file.length >= allowed.length && isSegmentPrefix(allowed, file)
}

export function isPathInAnyScope(path: string, scopes: readonly PathScope[]): boolean {
  return scopes.some((scope) => isPathInScope(path, scope))
}

/** P04: o que ficou fora de `touches`, ou dentro de `denyPaths`, reprova a tentativa. */
export function outOfScopePaths(
  changed: readonly string[],
  allowed: readonly PathScope[],
  denied: readonly PathScope[] = [],
): string[] {
  return changed.filter(
    (path) => !isPathInAnyScope(path, allowed) || isPathInAnyScope(path, denied),
  )
}
