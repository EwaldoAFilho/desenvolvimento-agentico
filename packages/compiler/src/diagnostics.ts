import type { DiagnosticSeverity } from '@agentic/domain'
import type { SourcePosition } from '@agentic/schemas'
import { hintOf, severityOf } from './catalog.js'
import type { Diagnostic, DiagnosticCode } from './types.js'

export interface DiagnosticInput {
  readonly message: string
  readonly targets: readonly string[]
  readonly at?: SourcePosition
  /** Sobrescreve a dica do catalogo quando o caso pede algo mais especifico. */
  readonly hint?: string
}

/**
 * Unico construtor de diagnostico. A severidade vem do catalogo, nunca do chamador —
 * e o que impede o mesmo codigo sair como ERROR num lugar e WARNING em outro.
 */
export function diagnostic(code: DiagnosticCode, input: DiagnosticInput): Diagnostic {
  return {
    code,
    severity: severityOf(code),
    message: input.message,
    targets: [...input.targets],
    line: input.at?.line,
    column: input.at?.column,
    hint: input.hint ?? hintOf(code),
  }
}

const SEVERITY_RANK: Readonly<Record<DiagnosticSeverity, number>> = {
  ERROR: 0,
  WARNING: 1,
  INFO: 2,
}

function compare(a: Diagnostic, b: Diagnostic): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (bySeverity !== 0) return bySeverity
  if (a.code !== b.code) return a.code < b.code ? -1 : 1
  const targetsA = a.targets.join(' ')
  const targetsB = b.targets.join(' ')
  if (targetsA !== targetsB) return targetsA < targetsB ? -1 : 1
  const lineA = a.line ?? Number.MAX_SAFE_INTEGER
  const lineB = b.line ?? Number.MAX_SAFE_INTEGER
  if (lineA !== lineB) return lineA - lineB
  if (a.message !== b.message) return a.message < b.message ? -1 : 1
  return 0
}

/**
 * Ordem total e independente da ordem de emissao: gravidade, codigo, alvos, linha,
 * mensagem. Compilar duas vezes a mesma missao devolve a mesma lista, na mesma ordem.
 */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(compare)
}

export function hasError(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === 'ERROR')
}

export function bySeverity(
  diagnostics: readonly Diagnostic[],
  severity: DiagnosticSeverity,
): Diagnostic[] {
  return diagnostics.filter((item) => item.severity === severity)
}

export function codesOf(diagnostics: readonly Diagnostic[]): DiagnosticCode[] {
  return diagnostics.map((item) => item.code)
}

export function findDiagnostic(
  diagnostics: readonly Diagnostic[],
  code: DiagnosticCode,
): Diagnostic | undefined {
  return diagnostics.find((item) => item.code === code)
}
