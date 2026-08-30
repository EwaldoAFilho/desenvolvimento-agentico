import type { Diagnostic } from '@agentic/compiler'
import type { CompileReportDto } from '@agentic/schemas'
import { pad } from './output.js'

/** Codigo · severidade · alvo · mensagem · linha/coluna quando o YAML permitiu localizar. */
export function renderDiagnostic(diagnostic: Diagnostic): string {
  const target = diagnostic.targets[0] ?? '-'
  const where =
    diagnostic.line === undefined
      ? ''
      : ` (linha ${diagnostic.line}, coluna ${diagnostic.column ?? 1})`
  const others = diagnostic.targets.slice(1)
  const cited = others.length === 0 ? '' : ` [${others.join(', ')}]`
  return `${pad(diagnostic.code, 7)} ${pad(diagnostic.severity, 8)} ${pad(target, 14)} ${diagnostic.message}${cited}${where}`
}

export function renderDiagnostics(diagnostics: readonly Diagnostic[]): string[] {
  if (diagnostics.length === 0) return ['  nenhum diagnostico']
  const lines: string[] = []
  for (const diagnostic of diagnostics) {
    lines.push(`  ${renderDiagnostic(diagnostic)}`)
    if (diagnostic.hint !== undefined) lines.push(`          ${diagnostic.hint}`)
  }
  return lines
}

export function summaryOf(report: CompileReportDto): string {
  const stats = report.stats
  return `${stats.errors} ERROR · ${stats.warnings} WARNING · ${stats.infos} INFO`
}
