import { compileMission, hasSeverity, toCompileReport } from '@agentic/orchestrator'
import { StartRunCommandSchema } from '@agentic/schemas'
import { compileInputOf, loadProjectContext, readMissionFile } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { renderDiagnostics } from '../diagnostics.js'
import { endpointOf } from '../link.js'
import { createOutput } from '../output.js'
import { findMissionRun, withPlane } from '../plane.js'
import { type CommandResult, failure, ok, usageError } from '../result.js'
import type { MissionFileArgs } from './mission-validate.js'

export interface StartArgs extends MissionFileArgs {
  readonly actor?: string
  readonly acceptWarnings?: boolean
  readonly serve?: boolean
  readonly port?: number
}

export interface StartData {
  /** Ausente quando o START foi entregue a um control plane remoto. */
  readonly runId?: string
  readonly missionId: string
  readonly status: string
  readonly warningsAccepted: boolean
  readonly tasks?: Record<string, number>
  readonly deliveredTo?: string
}

export function actorOf(args: { readonly actor?: string }, deps: CommandDeps): string {
  const declared = args.actor?.trim()
  if (declared !== undefined && declared.length > 0) return declared
  const user = deps.env.USER ?? deps.env.USERNAME
  return user === undefined || user.length === 0 ? 'humano' : user
}

/**
 * `mission start`: cria o Run e orquestra. Recusa missao nao aprovada, recusa ERROR e
 * exige aceite explicito quando ha WARNING (ARCHITECTURE 4.1, DASHBOARD 2.1).
 */
export async function missionStartCommand(
  args: StartArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const context = await loadProjectContext(deps, args)
  const mission = await readMissionFile(deps, args.file)
  const acceptWarnings = args.acceptWarnings === true
  const actor = actorOf(args, deps)

  const command = StartRunCommandSchema.safeParse({
    missionPath: mission.path,
    acceptWarnings,
    actor,
  })
  if (!command.success) {
    throw usageError(
      `start recusado: ${command.error.issues.map((issue) => issue.message).join('; ')}`,
      'INVALID_START',
    )
  }

  const result = compileMission(compileInputOf(context, mission))
  const report = toCompileReport(result, mission.text)
  if (!report.ok) {
    out.lines(renderDiagnostics(result.diagnostics))
    return failure(
      'mission start',
      'VALIDATION_FAILED',
      'missao com diagnostico ERROR nao inicia (P01)',
      report,
    )
  }

  const link = await deps.connect(endpointOf(context.project, args.port))
  if (link !== undefined) {
    // Ja ha control plane no ar: ele inicia o run — a CLI nao abre um segundo escritor.
    await link.send({ method: 'POST', path: '/api/runs', body: command.data })
    out.line(`START MISSION entregue ao control plane em ${link.endpoint}`)
    const remote: StartData = {
      missionId: report.missionId,
      status: 'RUNNING',
      warningsAccepted: acceptWarnings,
      deliveredTo: link.endpoint,
    }
    return ok('mission start', remote)
  }

  return withPlane(deps, context, async (plane): Promise<CommandResult> => {
    const run = await findMissionRun(plane, report.missionId, report.specHash)
    if (run === undefined) {
      return failure(
        'mission start',
        'NOT_APPROVED',
        `missao ${report.missionId} nao tem run aprovado para este specHash; rode \`agentic mission approve ${args.file} --actor <nome>\``,
      )
    }
    if (run.status !== 'APPROVED') {
      return failure(
        'mission start',
        'NOT_APPROVED',
        `run ${run.id} esta ${run.status}: START MISSION exige APPROVED (P01)`,
        { runId: run.id, missionId: run.missionId, status: run.status },
      )
    }
    if (hasSeverity(report.diagnostics, 'WARNING') && !acceptWarnings) {
      out.lines(renderDiagnostics(result.diagnostics))
      return failure(
        'mission start',
        'WARNINGS_NOT_ACCEPTED',
        `${report.stats.warnings} WARNING pendente(s): a partida exige --accept-warnings`,
        report,
      )
    }

    const started = await plane.startRun({
      runId: run.id,
      actor,
      acceptWarnings,
      diagnostics: report.diagnostics,
    })
    out.line(`run ${started.id} iniciado (${started.missionId})`)
    out.line(`  actor             ${actor}`)
    out.line(`  warnings aceitos  ${acceptWarnings ? 'sim' : 'nao'}`)
    out.line()

    const orchestrator = await plane.open(started.id)
    if (args.serve === true) {
      out.line('control plane em primeiro plano; Ctrl+C encerra.')
      out.line(
        'a API HTTP e o dashboard vivem em @agentic/server — a CLI nao os importa (fronteira interfaces).',
      )
      orchestrator.start()
      await deps.waitForShutdown()
      orchestrator.stop()
    } else {
      await orchestrator.drain()
    }

    const snapshot = await plane.getRunSnapshot(started.id)
    out.line(`status final: ${snapshot.run.status}`)
    out.line(
      `tasks: ${snapshot.counters.DONE} DONE · ${snapshot.counters.FAILED} FAILED · ${snapshot.counters.BLOCKED} BLOCKED · ${snapshot.counters.SKIPPED} SKIPPED`,
    )
    const data: StartData = {
      runId: snapshot.run.id,
      missionId: snapshot.run.missionId,
      status: snapshot.run.status,
      warningsAccepted: acceptWarnings,
      tasks: { ...snapshot.counters },
    }
    if (snapshot.run.status === 'FAILED') {
      return failure('mission start', 'RUN_FAILED', `run ${snapshot.run.id} terminou FAILED`, data)
    }
    return ok('mission start', data)
  })
}
