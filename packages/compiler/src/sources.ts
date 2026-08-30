import {
  formatIssuePath,
  type GatesFile,
  GatesFileSchema,
  type IssuePath,
  locateInYaml,
  type MissionFile,
  MissionFileSchema,
  type ParsedYaml,
  type ParseResult,
  type ProjectFile,
  ProjectFileSchema,
  parseYamlDocument,
  type SourcePosition,
  toPlainValue,
  toSchemaIssues,
} from '@agentic/schemas'
import { diagnostic } from './diagnostics.js'
import type { Diagnostic } from './types.js'

/** Qual dos tres arquivos declarativos originou o diagnostico (MISSION-FORMAT). */
export type SourceKind = 'mission' | 'project' | 'gates'

/** Mapeia um caminho de campo para linha/coluna no arquivo original. */
export type Locate = (path: IssuePath) => SourcePosition

const NOWHERE: Locate = () => ({})

export interface ParsedSource<TValue> {
  readonly kind: SourceKind
  readonly value?: TValue
  readonly locate: Locate
  readonly diagnostics: readonly Diagnostic[]
}

/** `mission.tasks[3].objective` — colavel numa busca dentro do arquivo. */
export function fieldTarget(kind: SourceKind, path: IssuePath): string {
  const formatted = formatIssuePath(path)
  return formatted.length === 0 ? kind : `${kind}.${formatted}`
}

/**
 * Um unico caminho para os tres arquivos: YAML (DA1000) -> schema (DA1001). O documento
 * parseado sobrevive ao passo de schema porque a validacao semantica tambem precisa
 * apontar linha e coluna.
 */
function parseSource<TValue>(
  kind: SourceKind,
  text: string,
  validate: (plain: unknown, parsed: ParsedYaml) => ParseResult<TValue>,
): ParsedSource<TValue> {
  const parsed = parseYamlDocument(text)
  if (!parsed.ok) {
    return {
      kind,
      locate: NOWHERE,
      diagnostics: parsed.issues.map((issue) =>
        diagnostic('DA1000', {
          message: `${kind}.yaml: YAML invalido — ${issue.message}`,
          targets: [kind],
          at: { line: issue.line, column: issue.column },
        }),
      ),
    }
  }

  const document = parsed.value
  const locate: Locate = (path) => locateInYaml(document, path)
  const result = validate(toPlainValue(document), document)
  if (!result.ok) {
    return {
      kind,
      locate,
      diagnostics: result.issues.map((issue) =>
        diagnostic('DA1001', {
          message: `${kind}.yaml: ${issue.path.length === 0 ? 'documento' : issue.path} — ${issue.message}`,
          targets: [issue.path.length === 0 ? kind : `${kind}.${issue.path}`],
          at: { line: issue.line, column: issue.column },
        }),
      ),
    }
  }

  return { kind, value: result.value, locate, diagnostics: [] }
}

export function parseMissionSource(text: string): ParsedSource<MissionFile> {
  return parseSource('mission', text, (plain, parsed) => {
    const result = MissionFileSchema.safeParse(plain)
    return result.success
      ? { ok: true, value: result.data }
      : { ok: false, issues: toSchemaIssues(result.error, parsed) }
  })
}

export function parseProjectSource(text: string): ParsedSource<ProjectFile> {
  return parseSource('project', text, (plain, parsed) => {
    const result = ProjectFileSchema.safeParse(plain)
    return result.success
      ? { ok: true, value: result.data }
      : { ok: false, issues: toSchemaIssues(result.error, parsed) }
  })
}

export function parseGatesSource(text: string): ParsedSource<GatesFile> {
  return parseSource('gates', text, (plain, parsed) => {
    const result = GatesFileSchema.safeParse(plain)
    return result.success
      ? { ok: true, value: result.data }
      : { ok: false, issues: toSchemaIssues(result.error, parsed) }
  })
}
