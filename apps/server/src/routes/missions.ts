import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Run } from '@agentic/domain'
import type { ApproveMissionCommand, CompileReportDto, RunHeaderDto } from '@agentic/schemas'
import { ApproveMissionCommandSchema } from '@agentic/schemas'
import type { FastifyInstance } from 'fastify'
import type { ServerDeps } from '../deps.js'
import { toRunHeader } from '../dto.js'
import { badRequest, toApiIssues } from '../errors.js'
import {
  compileMissionRef,
  compileMissionSource,
  findRun,
  missionSpecOf,
  readMissionSource,
  refuseOnErrors,
} from '../missions.js'

export interface MissionListItem {
  readonly file: string
  readonly path: string
}

export interface ApproveMissionResult {
  readonly runId: string
  readonly run: RunHeaderDto
  readonly report: CompileReportDto
  /** Aprovar duas vezes o MESMO spec nao gera segundo registro humano. */
  readonly alreadyApproved: boolean
}

interface MissionParams {
  readonly file: string
}

function missionRefOf(body: unknown, fallback?: string): string {
  const source = (body ?? {}) as Record<string, unknown>
  const ref = source.file ?? source.missionPath ?? source.missionId ?? fallback
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw badRequest('MISSION_REF_REQUIRED', 'informe a missao em `file`')
  }
  return ref
}

/** Sem `actor` nao ha aprovacao: o contrato exige o autor humano e o servidor nao inventa um. */
function approveCommandOf(body: unknown): ApproveMissionCommand {
  const source = (body ?? {}) as Record<string, unknown>
  const parsed = ApproveMissionCommandSchema.safeParse({
    actor: source.actor,
    ...(source.note === undefined ? {} : { note: source.note }),
  })
  if (!parsed.success) {
    throw badRequest('APPROVAL_REQUIRES_ACTOR', 'aprovacao exige o autor humano em `actor`', {
      issues: toApiIssues(parsed.error.issues),
    })
  }
  return parsed.data
}

/**
 * ApproveMission: ato humano REGISTRADO (`human.mission_approved` com `actor`). O Run nasce
 * aqui em DRAFT com o grafo CONGELADO — editar o YAML depois nao muda o que foi aprovado
 * (ADR-0005). Nao existe aprovacao automatica.
 */
async function approve(
  deps: ServerDeps,
  ref: string,
  body: unknown,
): Promise<ApproveMissionResult> {
  const command = approveCommandOf(body)
  const source = await readMissionSource(deps, ref)
  const compiled = compileMissionSource(deps, source)
  refuseOnErrors(compiled)
  const graph = compiled.graph
  if (graph === undefined) {
    throw badRequest('MISSION_HAS_ERRORS', 'missao nao compilou', {
      diagnostics: compiled.report.diagnostics,
    })
  }

  const lookup = { missionId: String(compiled.report.missionId), specHash: graph.specHash }
  const existing = await findRun(deps, { ...lookup, statuses: ['APPROVED'] })
  if (existing !== undefined) {
    return {
      runId: existing.id,
      run: toRunHeader(existing),
      report: compiled.report,
      alreadyApproved: true,
    }
  }

  const draft = await findRun(deps, { ...lookup, statuses: ['DRAFT'] })
  const target: Run =
    draft ??
    (await deps.plane.createRun({
      mission: missionSpecOf(source),
      compiled: graph,
      missionText: source.text,
    }))
  const approved = await deps.plane.approveMission({
    runId: target.id,
    actor: command.actor,
    ...(command.note === undefined ? {} : { note: command.note }),
  })
  return {
    runId: approved.id,
    run: toRunHeader(approved),
    report: compiled.report,
    alreadyApproved: false,
  }
}

export function registerMissionRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/missions', async (): Promise<MissionListItem[]> => {
    let entries: string[]
    try {
      entries = await readdir(deps.missionsDir)
    } catch {
      return []
    }
    return entries
      .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
      .sort()
      .map((name) => {
        const path = join(deps.missionsDir, name)
        return { file: relative(deps.repoRoot, path), path }
      })
  })

  app.get('/api/missions/compile', async (request): Promise<CompileReportDto> => {
    const query = request.query as Record<string, unknown>
    return (await compileMissionRef(deps, missionRefOf(query))).report
  })

  app.post('/api/missions/compile', async (request): Promise<CompileReportDto> => {
    return (await compileMissionRef(deps, missionRefOf(request.body))).report
  })

  app.get<{ Params: MissionParams }>(
    '/api/missions/:file/compile',
    async (request): Promise<CompileReportDto> => {
      return (await compileMissionRef(deps, request.params.file)).report
    },
  )

  app.post('/api/missions/approve', async (request, reply) => {
    return reply.status(200).send(await approve(deps, missionRefOf(request.body), request.body))
  })

  app.post<{ Params: MissionParams }>('/api/missions/:file/approve', async (request, reply) => {
    const ref = missionRefOf(request.body, request.params.file)
    return reply.status(200).send(await approve(deps, ref, request.body))
  })
}
