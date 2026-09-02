import { compileMission, toCompileReport } from '@agentic/orchestrator'
import { acquireControlPlaneOwnership } from '@agentic/persistence'
import { ApproveMissionCommandSchema, parseMissionFile, toMissionSpec } from '@agentic/schemas'
import { compileInputOf, describeIssues, loadProjectContext, readMissionFile } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { renderDiagnostics } from '../diagnostics.js'
import { discoverRuntime, resolveEndpoint } from '../discovery.js'
import type { ControlPlaneLink } from '../link.js'
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
  // Amarrado aqui: a funcao de aprovacao local e declarada (e hoisted), e la dentro o
  // compilador ja nao sabe que a validacao passou.
  const ato = command.data

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

  // Mesma descoberta dos comandos de mutacao: um control plane no ar em porta diferente da
  // declarada continua sendo o unico escritor (I7). Sem isto, `approve` abriria o banco por
  // fora dele so porque o endereco do `project.yaml` nao responde.
  const resolved = await resolveEndpoint(
    context,
    args.port === undefined ? {} : { port: args.port },
  )
  /** Ato humano entregue a quem ja e dono: a CLI nao abre um segundo escritor (I7, I14). */
  const entregarAoDono = async (link: ControlPlaneLink): Promise<CommandResult> => {
    await link.send({
      method: 'POST',
      path: `/api/missions/${report.missionId}/approve`,
      body: ato,
    })
    out.line(`missao ${report.missionId} aprovada por ${ato.actor} via ${link.endpoint}`)
    const remote: ApproveData = {
      missionId: report.missionId,
      status: 'APPROVED',
      actor: ato.actor,
      specHash: report.specHash,
      created: false,
      deliveredTo: link.endpoint,
    }
    return ok('mission approve', remote)
  }

  const link = await deps.connect(resolved.endpoint, { repoRoot: context.repoRoot })
  if (link !== undefined) return entregarAoDono(link)

  const parsed = parseMissionFile(mission.text)
  if (!parsed.ok) {
    throw new CliError(
      'MISSION_INVALID',
      [`${mission.path} invalido:`, ...describeIssues(parsed.issues)].join('\n'),
    )
  }
  const spec = toMissionSpec(parsed.value)

  /**
   * Ninguem atendeu — e aprovar CRIA run e GRAVA evento. Isso e mutacao, e mutacao pertence
   * a quem possui o projeto (I14).
   *
   * Este era o segundo bypass medido em 003B: `approve` ia direto para `withPlane`, abria o
   * `state.db` e escrevia sem nunca ter disputado a posse — inclusive com outro control
   * plane vivo no mesmo projeto. A disputa acontece AQUI, antes de abrir banco, e a posse e
   * devolvida no fim: `approve` e um ato curto, nao um control plane em pe.
   */
  const posse = acquireControlPlaneOwnership({ baseDir: context.runtimeDir })
  if (!posse.ok) {
    // Perder significa que existe um dono que o endereco tentado nao alcancou — tipicamente
    // um `--port` divergente. A descoberta e consultada SEM a flag e o ato vai para ele.
    const dono = await discoverRuntime(context)
    const outro =
      dono === undefined ? undefined : await deps.connect(dono.url, { repoRoot: context.repoRoot })
    if (outro !== undefined) return entregarAoDono(outro)
    return failure(
      'mission approve',
      'OWNERSHIP_ALREADY_HELD',
      [
        `outro control plane ja possui ${posse.ownedDir} e nao respondeu em ${resolved.endpoint}.`,
        'aprovar grava estado, e quem grava e o dono do projeto (I14): este comando nao vai',
        'abrir um segundo escritor. Descubra o endereco em .agentic/control-plane.json, ou',
        'encerre o control plane no ar.',
      ].join('\n'),
    )
  }

  const lease = posse.lease
  try {
    return await aprovarLocalmente()
  } finally {
    // A posse dura o ato, nao a sessao: solta-la aqui devolve o projeto para o proximo
    // comando ou para um `agentic serve`.
    lease.release()
  }

  function aprovarLocalmente(): Promise<CommandResult> {
    return withPlane(
      deps,
      context,
      async (plane): Promise<CommandResult> => {
        const existing = await findMissionRun(plane, report.missionId, report.specHash)
        if (existing !== undefined && existing.status !== 'DRAFT') {
          const data: ApproveData = {
            runId: existing.id,
            missionId: existing.missionId,
            status: existing.status,
            specHash: existing.specHash,
            actor: ato.actor,
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
          actor: ato.actor,
          ...(ato.note === undefined ? {} : { note: ato.note }),
        })

        out.line(`missao ${approved.missionId} aprovada`)
        out.line(`  run     ${approved.id}`)
        out.line(`  actor   ${ato.actor}`)
        out.line(`  status  ${approved.status}`)
        out.line()
        out.line(`proximo passo: agentic mission start ${args.file}`)

        const data: ApproveData = {
          runId: approved.id,
          missionId: approved.missionId,
          status: approved.status,
          actor: ato.actor,
          specHash: approved.specHash,
          created: existing === undefined,
        }
        return ok('mission approve', data)
      },
      lease,
    )
  }
}
