import {
  type CompiledGraph,
  type CompileInput,
  type CompileResult,
  compileMission as compile,
  type Diagnostic,
} from '@agentic/compiler'
import { type MissionId, missionId as toMissionId } from '@agentic/domain'
import { type CompileReportDto, type DiagnosticDto, parseMissionFile } from '@agentic/schemas'

export type { CompileInput, CompileResult }

/** Id de recurso quando nem o cabecalho da missao pode ser lido. */
export const UNKNOWN_MISSION = toMissionId('UNKNOWN-000')

export function hasSeverity(
  diagnostics: readonly { readonly severity: string }[],
  severity: string,
): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === severity)
}

function countOf(diagnostics: readonly Diagnostic[], severity: string): number {
  return diagnostics.filter((diagnostic) => diagnostic.severity === severity).length
}

function toDiagnosticDto(diagnostic: Diagnostic): DiagnosticDto {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    targets: [...diagnostic.targets],
    hint: diagnostic.hint,
  }
}

function missionIdOf(result: CompileResult, missionText: string): MissionId {
  const compiled = result.graph
  if (compiled !== undefined) return compiled.missionId
  const parsed = parseMissionFile(missionText)
  return parsed.ok ? toMissionId(parsed.value.id) : UNKNOWN_MISSION
}

function statsOf(graph: CompiledGraph | undefined, diagnostics: readonly Diagnostic[]) {
  const phases = new Set(graph?.nodes.map((node) => node.task.phase) ?? [])
  return {
    tasks: graph?.nodes.length ?? 0,
    phases: phases.size,
    edges: graph?.edges.length ?? 0,
    errors: countOf(diagnostics, 'ERROR'),
    warnings: countOf(diagnostics, 'WARNING'),
    infos: countOf(diagnostics, 'INFO'),
    criticalPathLength: graph?.criticalPath.length ?? 0,
    waves: graph?.waves.length ?? 0,
    maxParallelism: (graph?.waves ?? []).reduce((max, wave) => Math.max(max, wave.length), 0),
  }
}

/** Relatorio de compilacao no contrato publico: e o que a CLI e o dashboard mostram. */
export function toCompileReport(result: CompileResult, missionText: string): CompileReportDto {
  return {
    missionId: missionIdOf(result, missionText),
    specHash: result.graph?.specHash,
    ok: !hasSeverity(result.diagnostics, 'ERROR'),
    diagnostics: result.diagnostics.map(toDiagnosticDto),
    stats: statsOf(result.graph, result.diagnostics),
  }
}

/** CompileMission: funcao pura sobre o CONTEUDO dos tres arquivos (ARCHITECTURE 7). */
export function compileMission(input: CompileInput): CompileResult {
  return compile(input)
}

/** ValidateMission: mesma compilacao, saida em contrato — `ok: false` com qualquer ERROR. */
export function validateMission(input: CompileInput): CompileReportDto {
  return toCompileReport(compile(input), input.missionText)
}
