import { isNode, LineCounter, parseDocument } from 'yaml'
import type { IssuePath, ParseResult, SchemaIssue } from './issues.js'

type YamlDocument = ReturnType<typeof parseDocument>

/** Documento + contador de linhas: sem os dois nao ha como devolver linha/coluna. */
export interface ParsedYaml {
  readonly document: YamlDocument
  readonly lineCounter: LineCounter
}

export interface SourcePosition {
  readonly line?: number
  readonly column?: number
}

/**
 * `parseDocument` e nao `parse`: o documento preserva os nos e seus offsets, que sao a
 * unica forma de mapear um erro de schema de volta para o arquivo escrito pelo humano.
 */
export function parseYamlDocument(text: string): ParseResult<ParsedYaml> {
  const lineCounter = new LineCounter()
  let document: YamlDocument
  try {
    document = parseDocument(text, { lineCounter, prettyErrors: false })
  } catch (error) {
    return { ok: false, issues: [{ path: '', message: messageOf(error) }] }
  }

  if (document.errors.length > 0) {
    const issues = document.errors.map((error): SchemaIssue => {
      const offset = error.pos[0]
      const at = positionOf(lineCounter, offset)
      return { path: '', message: `${error.code}: ${error.message}`, ...at }
    })
    return { ok: false, issues }
  }

  return { ok: true, value: { document, lineCounter } }
}

/** Converte o documento em valor puro, pronto para o zod. Nunca lanca. */
export function toPlainValue(parsed: ParsedYaml): unknown {
  try {
    return parsed.document.toJS({ maxAliasCount: 100 })
  } catch {
    return undefined
  }
}

/**
 * Sobe o caminho ate achar um no existente: campo obrigatorio ausente nao tem no proprio,
 * mas o pai tem — e apontar para o bloco certo ja resolve o humano.
 */
export function locateInYaml(parsed: ParsedYaml, path: IssuePath): SourcePosition {
  const segments = [...path]
  while (segments.length > 0) {
    const offset = startOffset(parsed.document.getIn(segments, true))
    if (offset !== undefined) return positionOf(parsed.lineCounter, offset)
    segments.pop()
  }
  const root = startOffset(parsed.document.contents)
  return root === undefined ? {} : positionOf(parsed.lineCounter, root)
}

function startOffset(node: unknown): number | undefined {
  if (!isNode(node)) return undefined
  const range = node.range
  return range === undefined || range === null ? undefined : range[0]
}

function positionOf(lineCounter: LineCounter, offset: number): SourcePosition {
  const pos = lineCounter.linePos(offset)
  return { line: pos.line, column: pos.col }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
