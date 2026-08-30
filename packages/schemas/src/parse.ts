import type { z } from 'zod'
import { GatesFileSchema } from './gates-file.js'
import { formatIssuePath, type ParseResult, type SchemaIssue } from './issues.js'
import { MissionFileSchema } from './mission-file.js'
import { ProjectFileSchema } from './project-file.js'
import { locateInYaml, type ParsedYaml, parseYamlDocument, toPlainValue } from './yaml.js'

/**
 * Um unico caminho para os tres arquivos: YAML -> valor puro -> zod -> issues com
 * linha/coluna. Nunca lanca; erro e valor de retorno (ARCHITECTURE 7).
 */
export function parseWithSchema<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  text: string,
): ParseResult<z.infer<TSchema>> {
  const parsed = parseYamlDocument(text)
  if (!parsed.ok) return parsed

  const result = schema.safeParse(toPlainValue(parsed.value))
  if (result.success) return { ok: true, value: result.data as z.infer<TSchema> }
  return { ok: false, issues: toSchemaIssues(result.error, parsed.value) }
}

export function toSchemaIssues(error: z.ZodError, parsed: ParsedYaml): SchemaIssue[] {
  return error.issues.map((issue): SchemaIssue => {
    const at = locateInYaml(parsed, issue.path)
    return { path: formatIssuePath(issue.path), message: issue.message, ...at }
  })
}

export function parseMissionFile(text: string): ParseResult<z.infer<typeof MissionFileSchema>> {
  return parseWithSchema(MissionFileSchema, text)
}

export function parseProjectFile(text: string): ParseResult<z.infer<typeof ProjectFileSchema>> {
  return parseWithSchema(ProjectFileSchema, text)
}

export function parseGatesFile(text: string): ParseResult<z.infer<typeof GatesFileSchema>> {
  return parseWithSchema(GatesFileSchema, text)
}
