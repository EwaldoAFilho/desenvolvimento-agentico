import { compileMission, toCompileReport } from '@agentic/orchestrator'
import { ApproveMissionCommandSchema, parseMissionFile, toMissionSpec } from '@agentic/schemas'
import { compileInputOf, describeIssues, loadProjectContext, readMissionFile } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { renderDiagnostics } from '../diagnostics.js'
import { endpointOf } from '../link.js'
import { createOutput } from '../output.js'
import { findMissionRun, withPlane } from '../plane.js'
import { CliError, type CommandResult, failure, ok, usageError } from '../result.js'
import type { MissionFileArgs } from './mission-validate.js'

export interface ApproveArgs extends MissionFileArgs {
  readonly actor?: string
  readonly note?: string
  readonly port?: number
}

export interface ApproveData {
  /** Ausente quando o ato foi entregue a um control plane remoto: o run e dele. */
  readonly runId?: string
  readonly missionId: string
  readonly status: string
  readonly actor: string
  readonly specHash?: string
  readonly created: boolean
  readonly deliveredTo?: string
}

/**
 * `mission approve`: ato humano REGISTRADO com `actor`. Nao existe aprovacao automatica e
 * nao existe aprovacao anonima (ARCHITECTURE 4.1).
 */
export async function missionApproveCommand(
  args: ApproveArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const command = ApproveMissionCommandSchema.safeParse({
    actor: args.actor ?? '',
    ...(args.note === undefined ? {} : { note: args.note }),
  })
  if (!command.success) {
    throw usageError(
      `aprovacao exige --actor: ${command.error.issues.map((issue) => issue.message).join('; ')}`,
      'MISSING_ACTOR',
    )
  }

  const context = await loadProjectContext(deps, args)
  const mission = await readMissionFile(deps, args.file)
  const result = compileMission(compileInputOf(context, mission))
  const report = toCompileReport(result, mission.text)
  if (!report.ok || result.graph === undefined) {
    out.lines(renderDiagnostics(result.diagnostics))
    return failure(
      'mission approve',
      'VALIDATION_FAILED',
      'missao com diagnostico ERROR nao pode ser aprovada',
      report,
    )
  }
  const graph = result.graph

  const link = await deps.connect(endpointOf(context.project, args.port))
  if (link !== undefined) {
    // Ha control plane no ar: ele e o escritor (I7). A CLI so entrega o ato humano.
    await link.send({
      method: 'POST',
      path: `/api/missions/${report.missionId}/approve`,
      body: command.data,
    })
    out.line(`missao ${report.missionId} aprovada por ${command.data.actor} via ${link.endpoint}`)
    const remote: ApproveData = {
      missionId: report.missionId,
      status: 'APPROVED',
      actor: command.data.actor,
      specHash: report.specHash,
      created: false,
      deliveredTo: link.endpoint,
    }
    return ok('mission approve', remote)
  }

  const parsed = parseMissionFile(mission.text)
  if (!parsed.ok) {
    throw new CliError(
      'MISSION_INVALID',
      [`${mission.path} invalido:`, ...describeIssues(parsed.issues)].join('\n'),
    )
  }
  const spec = toMissionSpec(parsed.value)

  return withPlane(deps, context, async (plane): Promise<CommandResult> => {
    const existing = await findMissionRun(plane, report.missionId, report.specHash)
    if (existing !== undefined && existing.status !== 'DRAFT') {
      const data: ApproveData = {
        runId: existing.id,
        missionId: existing.missionId,
        status: existing.status,
        specHash: existing.specHash,
        actor: command.data.actor,
        created: false,
      }
      if (existing.status === 'APPROVED') {
        out.line(`run ${existing.id} ja esta APPROVED`)
        return ok('mission approve', data)
      }
      return failure(
        'mission approve',
        'RUN_NOT_DRAFT',
        `run ${existing.id} esta ${existing.status}: aprovacao so vale sobre DRAFT`,
        data,
      )
    }

    const run =
      existing ??
      (await plane.createRun({ mission: spec, compiled: graph, missionText: mission.text }))
    const approved = await plane.approveMission({
      runId: run.id,
      actor: command.data.actor,
      ...(command.data.note === undefined ? {} : { note: command.data.note }),
    })

    out.line(`missao ${approved.missionId} aprovada`)
    out.line(`  run     ${approved.id}`)
    out.line(`  actor   ${command.data.actor}`)
    out.line(`  status  ${approved.status}`)
    out.line()
    out.line(`proximo passo: agentic mission start ${args.file}`)

    const data: ApproveData = {
      runId: approved.id,
      missionId: approved.missionId,
      status: approved.status,
      actor: command.data.actor,
      specHash: approved.specHash,
      created: existing === undefined,
    }
    return ok('mission approve', data)
  })
}
