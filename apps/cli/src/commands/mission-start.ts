import type { ControlPlane } from '@agentic/orchestrator'
import { compileMission, hasSeverity, toCompileReport } from '@agentic/orchestrator'
import { StartRunCommandSchema } from '@agentic/schemas'
import {
  compileInputOf,
  loadProjectContext,
  type ProjectContext,
  readMissionFile,
} from '../context.js'
import type { BootedServer, CommandDeps } from '../deps.js'
import { renderDiagnostics } from '../diagnostics.js'
import { endpointOf } from '../link.js'
import { createOutput, type Output } from '../output.js'
import { findMissionRun, withPlane } from '../plane.js'
import { type CommandResult, failure, messageOf, ok, usageError } from '../result.js'
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

/**
 * Sobe a API sobre o plane deste processo. Falhar aqui NAO derruba o run: o run e o
 * produto, a porta e conveniencia — mas o usuario precisa saber que ficou sem ela.
 */
async function publishApi(
  deps: CommandDeps,
  context: ProjectContext,
  plane: ControlPlane,
  out: Output,
  port?: number,
): Promise<BootedServer | undefined> {
  const serve = deps.servePlane
  if (serve === undefined) return undefined
  try {
    return await serve({
      plane,
      project: context.project,
      projectText: context.projectText,
      gatesText: context.gatesText,
      repoRoot: context.repoRoot,
      ...(port === undefined ? {} : { port }),
    })
  } catch (error) {
    out.warn(`API HTTP indisponivel: ${messageOf(error)}`)
    return undefined
  }
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
      // MESMO plane: publicar a API sobre um segundo control plane abriria um segundo
      // escritor no mesmo banco (I7). Sem HTTP, `mission pause` nao teria a quem falar.
      const published = await publishApi(deps, context, plane, out, args.port)
      out.line(
        published === undefined
          ? 'control plane em primeiro plano, SEM API HTTP; Ctrl+C encerra.'
          : `control plane em primeiro plano; API e dashboard em ${published.url}; Ctrl+C encerra.`,
      )
      if (published !== undefined) {
        out.line('`agentic mission pause` e os demais comandos de mutacao alcancam este run.')
      }
      orchestrator.start()
      await deps.waitForShutdown()
      orchestrator.stop()
      if (published !== undefined) await published.close().catch(() => undefined)
    } else {
      // Sem `--serve` nao ha porta: pause, resume, stop, retry, unblock e skip nao alcancam
      // este run enquanto ele anda. Dizer isso ANTES e mais barato que descobrir na hora.
      out.line(
        'modo primeiro plano SEM API HTTP: este run nao pode ser comandado de outro terminal.',
      )
      out.line(
        `use \`agentic mission start ${args.file} --serve\` (ou deixe um \`agentic serve\` no ar)`,
      )
      out.line('para poder pausar, retomar ou parar enquanto ele executa. Ctrl+C encerra.')
      out.line()
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
