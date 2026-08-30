import type { CompiledGraph } from '@agentic/compiler'
import { compileMission, toCompileReport } from '@agentic/orchestrator'
import type { CompileReportDto } from '@agentic/schemas'
import { compileInputOf, loadProjectContext, readMissionFile } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { renderDiagnostics, summaryOf } from '../diagnostics.js'
import { createOutput } from '../output.js'
import { type CommandResult, failure, ok } from '../result.js'
import type { MissionFileArgs } from './mission-validate.js'

export interface PhaseTasksDto {
  readonly phase: string
  readonly tasks: readonly string[]
}

export interface TouchConflictDto {
  readonly tasks: readonly [string, string]
  readonly paths: readonly { readonly left: string; readonly right: string }[]
}

/** Forma estavel do DAG na CLI: o que ARCHITECTURE 7.2 chama de analises produzidas. */
export interface CompiledDagDto {
  readonly tasksByPhase: readonly PhaseTasksDto[]
  readonly topologicalOrder: readonly string[]
  readonly waves: readonly (readonly string[])[]
  readonly criticalPath: { readonly tasks: readonly string[]; readonly length: number }
  readonly concurrentPairs: readonly (readonly [string, string])[]
  readonly touchConflicts: readonly TouchConflictDto[]
}

export interface CompileData {
  readonly report: CompileReportDto
  readonly graph?: CompiledDagDto
}

export function toDagDto(graph: CompiledGraph): CompiledDagDto {
  const byPhase = new Map<string, string[]>()
  for (const node of graph.nodes) {
    const bucket = byPhase.get(node.task.phase) ?? []
    bucket.push(node.task.id)
    byPhase.set(node.task.phase, bucket)
  }
  return {
    tasksByPhase: [...byPhase].map(([phase, tasks]) => ({ phase, tasks })),
    topologicalOrder: [...graph.topologicalOrder],
    waves: graph.waves.map((wave) => [...wave]),
    criticalPath: { tasks: [...graph.criticalPath.tasks], length: graph.criticalPath.length },
    concurrentPairs: graph.concurrencyMatrix.map((pair) => [pair[0], pair[1]] as const),
    touchConflicts: graph.touchConflicts.map((conflict) => ({
      tasks: [conflict.tasks[0], conflict.tasks[1]] as const,
      paths: conflict.paths.map((path) => ({ left: path.left, right: path.right })),
    })),
  }
}

const MAX_PAIRS_SHOWN = 12

/** `mission compile`: imprime o DAG que o orquestrador vai congelar no run. */
export async function missionCompileCommand(
  args: MissionFileArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const context = await loadProjectContext(deps, args)
  const mission = await readMissionFile(deps, args.file)
  const result = compileMission(compileInputOf(context, mission))
  const report = toCompileReport(result, mission.text)
  const graph = result.graph

  out.line(`missao ${report.missionId} · ${mission.path}`)
  out.line()

  if (graph === undefined) {
    out.line('diagnosticos')
    out.lines(renderDiagnostics(result.diagnostics))
    out.line()
    out.line(summaryOf(report))
    return failure('mission compile', 'COMPILE_FAILED', 'missao com ERROR nao produz grafo', {
      report,
    } satisfies CompileData)
  }

  const dag = toDagDto(graph)

  out.line('tasks por fase')
  for (const phase of dag.tasksByPhase) {
    out.line(`  ${phase.phase}: ${phase.tasks.join(' ')}`)
  }
  out.line()
  out.line('waves (earliest start)')
  dag.waves.forEach((wave, index) => {
    out.line(`  ${index + 1}. ${wave.join(' ')}`)
  })
  out.line()
  out.line(
    `caminho critico (${dag.criticalPath.tasks.length} tasks, comprimento ${dag.criticalPath.length})`,
  )
  out.line(`  ${dag.criticalPath.tasks.join(' -> ')}`)
  out.line()
  out.line(`pares concorrentes: ${dag.concurrentPairs.length}`)
  for (const pair of dag.concurrentPairs.slice(0, MAX_PAIRS_SHOWN)) {
    out.line(`  ${pair[0]} || ${pair[1]}`)
  }
  if (dag.concurrentPairs.length > MAX_PAIRS_SHOWN) {
    out.line(`  ... mais ${dag.concurrentPairs.length - MAX_PAIRS_SHOWN}`)
  }
  out.line()
  out.line(`conflitos de touches: ${dag.touchConflicts.length}`)
  for (const conflict of dag.touchConflicts) {
    const paths = conflict.paths.map((path) => `${path.left} x ${path.right}`).join(', ')
    out.line(`  ${conflict.tasks[0]} x ${conflict.tasks[1]}: ${paths}`)
  }
  out.line()
  out.line('diagnosticos')
  out.lines(renderDiagnostics(result.diagnostics))
  out.line()
  out.line(`${summaryOf(report)} · specHash ${report.specHash ?? '-'}`)

  return ok('mission compile', { report, graph: dag } satisfies CompileData)
}
