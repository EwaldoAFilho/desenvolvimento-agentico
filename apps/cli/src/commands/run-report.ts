import { renderMissionReport } from '@agentic/orchestrator'
import { loadProjectContext } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { createOutput, duration } from '../output.js'
import { resolveRunId, withPlane } from '../plane.js'
import { type CommandResult, ok } from '../result.js'

export interface RunReportArgs {
  readonly runId?: string
  readonly md?: boolean
  readonly project?: string
  readonly json?: boolean
}

/**
 * `run report`: o que a missao PRODUZIU, medido. Evidencia citavel — comando, cwd e exit
 * code que um humano repete no terminal (P08).
 */
export async function runReportCommand(
  args: RunReportArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const context = await loadProjectContext(deps, args)
  return withPlane(deps, context, async (plane) => {
    const runId = await resolveRunId(plane, args.runId)
    const report = await plane.generateMissionReport(runId)

    if (args.md === true) {
      out.lines(renderMissionReport(report).split('\n'))
      return ok('run report', report)
    }

    out.line(`relatorio da missao ${report.missionId} · run ${report.runId} · ${report.status}`)
    out.line()
    out.line(
      `tasks: ${report.tasks.done}/${report.tasks.total} DONE · ${report.tasks.skipped} puladas` +
        ` · ${report.tasks.cancelled} canceladas · ${report.tasks.blocked} bloqueadas`,
    )
    out.line(
      `tentativas ${report.attempts} · retries ${report.retries} · reprovacoes de review ${report.reviewFailures}`,
    )
    out.line(
      `mission gate: ${report.missionGate === undefined ? 'nao declarado' : `${report.missionGate.gateId} ${report.missionGate.status}`}`,
    )
    out.line(`wall time: ${duration(report.wallTimeMs)}`)
    out.line()
    out.line(
      `caminho critico real (${duration(report.criticalPath.durationMs)}): ${report.criticalPath.tasks.join(' -> ') || '-'}`,
    )
    out.line()
    out.line('tasks mais demoradas')
    for (const task of report.slowestTasks) {
      out.line(`  ${task.taskId} ${task.title}: ${duration(task.durationMs)}`)
    }
    if (report.retriedTasks.length > 0) {
      out.line()
      out.line('tasks com retry')
      for (const task of report.retriedTasks) {
        out.line(
          `  ${task.taskId}: ${task.attempts} tentativas (${task.failures.join(', ') || '-'})`,
        )
      }
    }
    if (report.blockages.length > 0) {
      out.line()
      out.line('bloqueios')
      for (const blockage of report.blockages) {
        out.line(
          `  ${blockage.taskId} [${blockage.kind}] ${blockage.reason} — precisa: ${blockage.needs}`,
        )
      }
    }
    out.line()
    out.line('evidencia citavel')
    if (report.evidence.length === 0) out.line('  nenhuma execucao de gate registrada')
    for (const evidence of report.evidence) {
      out.line(
        `  ${evidence.taskId ?? 'mission'} · ${evidence.gateId} · exit ${evidence.exitCode ?? 'sem codigo'} · ${evidence.command}`,
      )
    }
    return ok('run report', report)
  })
}
