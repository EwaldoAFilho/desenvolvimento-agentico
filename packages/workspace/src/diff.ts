import {
  diffStatOf,
  evaluateScope,
  type FileChange,
  type FileChangeKind,
  type Observation,
  type PathScope,
} from '@agentic/domain'

/**
 * O dominio guarda so a referencia (`diffRef`); o texto do patch viaja junto para que o
 * chamador decida onde persistir.
 */
export interface AttemptObservation extends Observation {
  readonly patch: string
}

export interface WorkspaceScope {
  readonly touches: readonly PathScope[]
  readonly denyPaths: readonly PathScope[]
}

export const EMPTY_SCOPE: WorkspaceScope = { touches: [], denyPaths: [] }

export interface NameStatusEntry {
  readonly change: FileChangeKind
  readonly path: string
  readonly renamedFrom?: string
}

export interface NumstatEntry {
  readonly path: string
  readonly added: number
  readonly removed: number
  readonly renamedFrom?: string
}

const CHANGE_KINDS: ReadonlySet<string> = new Set<FileChangeKind>(['A', 'M', 'D', 'R', 'C', 'T'])

/** Status desconhecido (`U`, `X`) nao some do relatorio: entra como modificacao. */
function toChangeKind(raw: string): FileChangeKind {
  const letter = raw.charAt(0).toUpperCase()
  return CHANGE_KINDS.has(letter) ? (letter as FileChangeKind) : 'M'
}

function splitNul(raw: string): string[] {
  return raw.split('\0').filter((token) => token.length > 0)
}

/** `git diff --name-status -z`: `<status>\0<path>\0` e `R<score>\0<origem>\0<destino>\0`. */
export function parseNameStatusZ(raw: string): NameStatusEntry[] {
  const tokens = splitNul(raw)
  const entries: NameStatusEntry[] = []
  let index = 0
  while (index < tokens.length) {
    const status = tokens[index]
    index += 1
    if (status === undefined) break
    const kind = toChangeKind(status)
    if (kind === 'R' || kind === 'C') {
      const from = tokens[index]
      const to = tokens[index + 1]
      index += 2
      if (from === undefined || to === undefined) break
      entries.push({ change: kind, path: to, renamedFrom: from })
      continue
    }
    const path = tokens[index]
    index += 1
    if (path === undefined) break
    entries.push({ change: kind, path })
  }
  return entries
}

function toCount(raw: string): number {
  // `-` marca binario: sem contagem de linha, nunca NaN.
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/** `git diff --numstat -z`: `<add>\t<del>\t<path>\0`; renomeio deixa o path vazio e usa 2 tokens. */
export function parseNumstatZ(raw: string): NumstatEntry[] {
  const tokens = splitNul(raw)
  const entries: NumstatEntry[] = []
  let index = 0
  while (index < tokens.length) {
    const record = tokens[index]
    index += 1
    if (record === undefined) continue
    const firstTab = record.indexOf('\t')
    const secondTab = record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const added = toCount(record.slice(0, firstTab))
    const removed = toCount(record.slice(firstTab + 1, secondTab))
    const rest = record.slice(secondTab + 1)
    if (rest.length > 0) {
      entries.push({ path: rest, added, removed })
      continue
    }
    const from = tokens[index]
    const to = tokens[index + 1]
    index += 2
    if (from === undefined || to === undefined) break
    entries.push({ path: to, added, removed, renamedFrom: from })
  }
  return entries
}

export function mergeDiffEntries(
  status: readonly NameStatusEntry[],
  numstat: readonly NumstatEntry[],
): FileChange[] {
  const counts = new Map<string, NumstatEntry>()
  for (const entry of numstat) counts.set(entry.path, entry)

  const changes: FileChange[] = []
  const seen = new Set<string>()
  for (const entry of status) {
    const count = counts.get(entry.path)
    seen.add(entry.path)
    changes.push({
      path: entry.path,
      change: entry.change,
      added: count?.added ?? 0,
      removed: count?.removed ?? 0,
      ...(entry.renamedFrom === undefined ? {} : { renamedFrom: entry.renamedFrom }),
    })
  }
  // numstat sem name-status seria anomalia; entra como modificacao para nao sumir do escopo.
  for (const entry of numstat) {
    if (seen.has(entry.path)) continue
    changes.push({
      path: entry.path,
      change: 'M',
      added: entry.added,
      removed: entry.removed,
      ...(entry.renamedFrom === undefined ? {} : { renamedFrom: entry.renamedFrom }),
    })
  }
  return changes
}

/** Renomeio move dois caminhos: origem e destino sao verificados contra o escopo. */
export function scopedPaths(changes: readonly FileChange[]): string[] {
  const paths: string[] = []
  for (const change of changes) {
    paths.push(change.path)
    if (change.renamedFrom !== undefined) paths.push(change.renamedFrom)
  }
  return paths
}

export function excludeLinkedPaths(
  changes: readonly FileChange[],
  links: readonly string[],
): FileChange[] {
  if (links.length === 0) return [...changes]
  const prefixes = links.map((link) => link.replace(/\/+$/, ''))
  return changes.filter((change) => {
    const path = change.path
    return !prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  })
}

export interface ObservationInput {
  readonly changes: readonly FileChange[]
  readonly scope: WorkspaceScope
  readonly patch: string
  readonly commit?: string
}

/**
 * Fail-closed: a regra de prefixo vem do dominio (`evaluateScope`) e caminho que nao se
 * consegue classificar cai como fora de escopo.
 */
export function buildObservation(input: ObservationInput): AttemptObservation {
  const evaluation = evaluateScope(
    scopedPaths(input.changes),
    input.scope.touches,
    input.scope.denyPaths,
  )
  return {
    filesChanged: [...input.changes],
    diffStat: diffStatOf(input.changes),
    outOfScopePaths: evaluation.outOfScopePaths,
    scopeCheck: evaluation.scopeCheck,
    commit: input.commit,
    patch: input.patch,
  }
}
