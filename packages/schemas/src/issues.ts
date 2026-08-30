/**
 * Fronteira de serializacao: todo erro sai como dado, nunca como excecao. Um arquivo
 * invalido precisa dizer ONDE esta o problema, senao o humano nao corrige (ARCHITECTURE 7).
 */
export interface SchemaIssue {
  readonly path: string
  readonly message: string
  readonly line?: number
  readonly column?: number
}

export interface ParseOk<T> {
  readonly ok: true
  readonly value: T
}

export interface ParseFail {
  readonly ok: false
  readonly issues: SchemaIssue[]
}

export type ParseResult<T> = ParseOk<T> | ParseFail

export type IssuePath = readonly (string | number)[]

/** `tasks[3].objective` — legivel por humano e colavel numa busca. Raiz vira string vazia. */
export function formatIssuePath(path: IssuePath): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`
    else if (out.length === 0) out = segment
    else out += `.${segment}`
  }
  return out
}

export function issuesOf(result: ParseResult<unknown>): SchemaIssue[] {
  return result.ok ? [] : result.issues
}

export function issueAt(result: ParseResult<unknown>, path: string): SchemaIssue | undefined {
  return issuesOf(result).find((issue) => issue.path === path)
}
