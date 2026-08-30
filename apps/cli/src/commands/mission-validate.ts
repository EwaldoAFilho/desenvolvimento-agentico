import { compileMission, toCompileReport } from '@agentic/orchestrator'
import { compileInputOf, loadProjectContext, readMissionFile } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { renderDiagnostics, summaryOf } from '../diagnostics.js'
import { createOutput } from '../output.js'
import { type CommandResult, failure, ok } from '../result.js'

export interface MissionFileArgs {
  readonly file: string
  readonly project?: string
  readonly json?: boolean
}

/**
 * `mission validate`: schema + semantica. Sai 0 SOMENTE quando nao ha ERROR; WARNING e
 * INFO aparecem e nao reprovam (P01).
 */
export async function missionValidateCommand(
  args: MissionFileArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const context = await loadProjectContext(deps, args)
  const mission = await readMissionFile(deps, args.file)
  const result = compileMission(compileInputOf(context, mission))
  const report = toCompileReport(result, mission.text)

  out.line(`missao ${report.missionId} · ${mission.path}`)
  out.line(`projeto ${context.projectPath}`)
  out.line()
  out.lines(renderDiagnostics(result.diagnostics))
  out.line()
  out.line(summaryOf(report))

  if (!report.ok) {
    return failure(
      'mission validate',
      'VALIDATION_FAILED',
      `${report.stats.errors} diagnostico(s) ERROR: a missao nao compila`,
      report,
    )
  }
  out.line(
    `ok: ${report.stats.tasks} tasks, ${report.stats.phases} fases, ${report.stats.waves} waves`,
  )
  return ok('mission validate', report)
}
