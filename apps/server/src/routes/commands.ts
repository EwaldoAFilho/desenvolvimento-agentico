import type { RunId, TaskId } from '@agentic/domain'
import { loadCompileReport } from '@agentic/orchestrator'
import type { DiagnosticDto, RunHeaderDto, StartRunCommand } from '@agentic/schemas'
import {
  RetryTaskCommandSchema,
  SkipTaskCommandSchema,
  StartRunCommandSchema,
  UnblockTaskCommandSchema,
} from '@agentic/schemas'
import type { FastifyInstance } from 'fastify'
import type { ServerDeps } from '../deps.js'
import { parseRunId, parseTaskId, toRunHeader } from '../dto.js'
import { badRequest, toApiIssues } from '../errors.js'
import { compileMissionRef, findRun, refuseOnErrors } from '../missions.js'
import { loadRunOr404 } from './read.js'

/** Comando humano sem autor identificado ainda e humano: o registro nao fica vazio. */
export const DEFAULT_ACTOR = 'humano'

export interface StartRunResult {
  readonly runId: string
  readonly run: RunHeaderDto
}

export interface CommandResult {
  readonly runId: string
  readonly status: string
  readonly taskId?: string
}

interface RunParams {
  readonly id: string
}

interface TaskParams extends RunParams {
  readonly taskId: string
}

function bodyOf(raw: unknown): Record<string, unknown> {
  return (raw ?? {}) as Record<string, unknown>
}

function actorOf(body: Record<string, unknown>): string {
  const actor = body.actor
  return typeof actor === 'string' && actor.trim().length > 0 ? actor : DEFAULT_ACTOR
}

function startCommandOf(raw: unknown): StartRunCommand {
  const body = bodyOf(raw)
  const path = body.missionPath ?? body.file
  const parsed = StartRunCommandSchema.safeParse({
    ...(path === undefined ? {} : { missionPath: path }),
    ...(body.missionId === undefined || path !== undefined ? {} : { missionId: body.missionId }),
    acceptWarnings: body.acceptWarnings ?? false,
    actor: body.actor,
    ...(body.specHash === undefined ? {} : { specHash: body.specHash }),
  })
  if (!parsed.success) {
    throw badRequest('START_COMMAND_INVALID', 'START MISSION recusado: comando invalido', {
      issues: toApiIssues(parsed.error.issues),
    })
  }
  return parsed.data
}

function warningsOf(diagnostics: readonly DiagnosticDto[]): DiagnosticDto[] {
  return diagnostics.filter((item) => item.severity === 'WARNING')
}

/**
 * START MISSION. O servidor faz exatamente tres coisas: compila para recusar ERROR com a
 * lista, exige o aceite explicito de WARNING e chama StartRun. Quem descobre o que rodar e
 * o orquestrador — nao existe despacho task a task por aqui (ARCHITECTURE 4.1).
 */
async function startRun(deps: ServerDeps, raw: unknown): Promise<StartRunResult> {
  const command = startCommandOf(raw)
  let missionId = command.missionId
  let specHash: string | undefined

  if (command.missionPath !== undefined) {
    const compiled = await compileMissionRef(deps, command.missionPath)
    refuseOnErrors(compiled)
    missionId = String(compiled.report.missionId)
    specHash = compiled.graph?.specHash
  }
  if (missionId === undefined) {
    throw badRequest('MISSION_REF_REQUIRED', 'informe a missao em `file`')
  }
  // A partida e do PLANO INSPECIONADO (U16/MVP-002): o hash declarado pelo cliente manda;
  // sem ele, o arquivo e recompilado e a partida fica presa a versao que esta no disco.
  // Em nenhum caso "qualquer run APPROVED desta missao" serve — um APPROVED antigo faria
  // partir um plano que ninguem inspecionou.
  if (command.specHash !== undefined) {
    if (specHash !== undefined && specHash !== command.specHash) {
      throw badRequest(
        'MISSION_CHANGED',
        `missao ${missionId} mudou desde a inspecao: o arquivo compila para outro plano`,
      )
    }
    specHash = command.specHash
  } else if (specHash === undefined) {
    const compiled = await compileMissionRef(deps, missionId)
    refuseOnErrors(compiled)
    specHash = compiled.graph?.specHash
  }

  const lookup = { missionId, ...(specHash === undefined ? {} : { specHash }) }
  const approved = await findRun(deps, { ...lookup, statuses: ['APPROVED'] })
  if (approved === undefined) {
    // Sem run APPROVED ha dois casos diferentes. Mandar "aprove" para um spec que JA partiu
    // faz nascer um segundo run do mesmo spec: a recusa precisa dizer qual e o caso.
    const existing = await findRun(deps, lookup)
    throw badRequest(
      'MISSION_NOT_APPROVED',
      existing === undefined
        ? `missao ${missionId} nao esta APPROVED: aprovar e ato humano (POST /api/missions/approve)`
        : `missao ${missionId} nao tem run APPROVED: o run ${existing.id} deste spec esta ` +
            `${existing.status}. Aprovar de novo cria um NOVO run do mesmo spec.`,
    )
  }

  // Os diagnosticos que valem sao os CONGELADOS na aprovacao, nao os de agora.
  const persisted = await loadCompileReport(deps.plane.deps, approved.id)
  const warnings = warningsOf(persisted?.diagnostics ?? [])
  if (warnings.length > 0 && !command.acceptWarnings) {
    throw badRequest(
      'WARNINGS_NOT_ACCEPTED',
      `missao ${missionId} tem ${warnings.length} aviso(s): a partida exige acceptWarnings: true`,
      { diagnostics: warnings },
    )
  }

  const started = await deps.plane.startRun({
    runId: approved.id,
    actor: command.actor,
    acceptWarnings: command.acceptWarnings,
  })
  // Um clique: daqui em diante o loop do orquestrador descobre TODAS as tasks READY.
  await deps.launcher.start(started.id)
  return { runId: started.id, run: toRunHeader(started) }
}

async function resultOf(deps: ServerDeps, id: RunId, taskId?: TaskId): Promise<CommandResult> {
  const run = await loadRunOr404(deps, id)
  return { runId: run.id, status: run.status, ...(taskId === undefined ? {} : { taskId }) }
}

/**
 * Comandos de mutacao. TODOS passam por um caso de uso de `@agentic/orchestrator`: o
 * servidor nunca abre transacao nem grava evento por conta propria (I7).
 */
export function registerCommandRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post('/api/runs', async (request, reply) => {
    return reply.status(201).send(await startRun(deps, request.body))
  })

  app.post<{ Params: RunParams }>('/api/runs/:id/pause', async (request) => {
    const id = parseRunId(request.params.id)
    const body = bodyOf(request.body)
    await deps.plane.pauseRun(id, { actor: actorOf(body) })
    return resultOf(deps, id)
  })

  app.post<{ Params: RunParams }>('/api/runs/:id/resume', async (request) => {
    const id = parseRunId(request.params.id)
    const body = bodyOf(request.body)
    await deps.plane.resumeRun(id, { actor: actorOf(body) })
    return resultOf(deps, id)
  })

  app.post<{ Params: RunParams }>('/api/runs/:id/stop', async (request) => {
    const id = parseRunId(request.params.id)
    const body = bodyOf(request.body)
    await deps.plane.stopRun(id, { actor: actorOf(body) })
    return resultOf(deps, id)
  })

  app.post<{ Params: TaskParams }>('/api/runs/:id/tasks/:taskId/retry', async (request) => {
    const id = parseRunId(request.params.id)
    const taskId = parseTaskId(request.params.taskId)
    const body = bodyOf(request.body)
    const reason = body.reason ?? body.note
    const parsed = RetryTaskCommandSchema.safeParse({
      taskId,
      actor: actorOf(body),
      ...(reason === undefined ? {} : { reason }),
    })
    if (!parsed.success) {
      throw badRequest('RETRY_INVALID', 'retry recusado', {
        issues: toApiIssues(parsed.error.issues),
      })
    }
    await deps.plane.retryTask(id, {
      taskId,
      actor: parsed.data.actor ?? DEFAULT_ACTOR,
      ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
    })
    return resultOf(deps, id, taskId)
  })

  // Nota OBRIGATORIA: desbloquear e decisao humana e fica registrada (DASHBOARD 7).
  app.post<{ Params: TaskParams }>('/api/runs/:id/tasks/:taskId/unblock', async (request) => {
    const id = parseRunId(request.params.id)
    const taskId = parseTaskId(request.params.taskId)
    const body = bodyOf(request.body)
    const parsed = UnblockTaskCommandSchema.safeParse({
      taskId,
      actor: actorOf(body),
      note: body.note,
    })
    if (!parsed.success) {
      throw badRequest('UNBLOCK_REQUIRES_NOTE', 'unblock exige nota em `note`', {
        issues: toApiIssues(parsed.error.issues),
      })
    }
    await deps.plane.unblockTask(id, {
      taskId,
      actor: parsed.data.actor ?? DEFAULT_ACTOR,
      note: parsed.data.note,
    })
    return resultOf(deps, id, taskId)
  })

  // Motivo OBRIGATORIO: dispensar trabalho fica registrado (DASHBOARD 7).
  app.post<{ Params: TaskParams }>('/api/runs/:id/tasks/:taskId/skip', async (request) => {
    const id = parseRunId(request.params.id)
    const taskId = parseTaskId(request.params.taskId)
    const body = bodyOf(request.body)
    const parsed = SkipTaskCommandSchema.safeParse({
      taskId,
      actor: actorOf(body),
      reason: body.reason,
    })
    if (!parsed.success) {
      throw badRequest('SKIP_REQUIRES_REASON', 'skip exige motivo em `reason`', {
        issues: toApiIssues(parsed.error.issues),
      })
    }
    await deps.plane.skipTask(id, {
      taskId,
      actor: parsed.data.actor ?? DEFAULT_ACTOR,
      reason: parsed.data.reason,
    })
    return resultOf(deps, id, taskId)
  })
}
