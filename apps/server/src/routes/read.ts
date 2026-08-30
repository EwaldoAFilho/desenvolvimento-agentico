import type { Run, RunId, RunStatus } from '@agentic/domain'
import { RUN_STATUSES, runId as toRunId } from '@agentic/domain'
import { renderMissionReport, toEventDto, toProviderHealthDto } from '@agentic/orchestrator'
import type {
  EventDto,
  ProviderHealthDto,
  RunHeaderDto,
  RunSnapshot,
  TaskDetail,
} from '@agentic/schemas'
import type { FastifyInstance } from 'fastify'
import type { ServerDeps } from '../deps.js'
import { parseRunId, parseTaskId, toRunHeader } from '../dto.js'
import { badRequest, notFound } from '../errors.js'
import { optionalInt } from '../query.js'

export interface HealthBody {
  readonly status: 'ok'
  readonly service: string
  readonly startedAt: string
  readonly uptimeMs: number
  readonly repoRoot: string
}

interface RunParams {
  readonly id: string
}

interface TaskParams extends RunParams {
  readonly taskId: string
}

export async function loadRunOr404(deps: ServerDeps, id: RunId): Promise<Run> {
  const run = await deps.plane.persistence.runs.loadRun(id)
  if (run === undefined) throw notFound('RUN_NOT_FOUND', `run ${id} nao existe`)
  return run
}

function statusFilterOf(raw: unknown): RunStatus[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const wanted = raw.split(',').map((item) => item.trim())
  const invalid = wanted.filter((item) => !RUN_STATUSES.includes(item as RunStatus))
  if (invalid.length > 0) {
    throw badRequest('INVALID_QUERY', `status desconhecido: ${invalid.join(', ')}`)
  }
  return wanted as RunStatus[]
}

/**
 * Leitura pura. Toda resposta sai de um caso de uso do orquestrador ou de uma consulta de
 * `@agentic/persistence` — o servidor nao recalcula estado nem inventa campo.
 */
export function registerReadRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const startedAt = new Date()

  app.get('/api/health', async (): Promise<HealthBody> => {
    return {
      status: 'ok',
      service: '@agentic/server',
      startedAt: startedAt.toISOString(),
      uptimeMs: Math.max(0, Date.now() - startedAt.getTime()),
      repoRoot: deps.repoRoot,
    }
  })

  app.get('/api/runs', async (request): Promise<RunHeaderDto[]> => {
    const query = request.query as Record<string, unknown>
    const status = statusFilterOf(query.status)
    const limit = optionalInt(query.limit, 'limit')
    const rows = deps.plane.persistence.queries.listRuns({
      ...(status === undefined ? {} : { status }),
      ...(limit === undefined ? {} : { limit }),
    })
    const runs: RunHeaderDto[] = []
    for (const row of rows) {
      const run = await deps.plane.persistence.runs.loadRun(toRunId(row.id))
      if (run !== undefined) runs.push(toRunHeader(run))
    }
    return runs
  })

  app.get<{ Params: RunParams }>('/api/runs/:id', async (request): Promise<RunHeaderDto> => {
    return toRunHeader(await loadRunOr404(deps, parseRunId(request.params.id)))
  })

  app.get<{ Params: RunParams }>(
    '/api/runs/:id/snapshot',
    async (request): Promise<RunSnapshot> => {
      return deps.plane.getRunSnapshot(parseRunId(request.params.id))
    },
  )

  app.get<{ Params: TaskParams }>(
    '/api/runs/:id/tasks/:taskId',
    async (request): Promise<TaskDetail> => {
      const id = parseRunId(request.params.id)
      return deps.plane.getTaskDetail(id, parseTaskId(request.params.taskId))
    },
  )

  // `since` e EXCLUSIVO: o cliente pede a partir do ultimo `seq` que viu (ARCHITECTURE 6.3).
  app.get<{ Params: RunParams }>('/api/runs/:id/events', async (request): Promise<EventDto[]> => {
    const id = parseRunId(request.params.id)
    await loadRunOr404(deps, id)
    const query = request.query as Record<string, unknown>
    const since = optionalInt(query.since, 'since') ?? 0
    const limit = optionalInt(query.limit, 'limit')
    const events = await deps.plane.persistence.events.list(id, {
      afterSeq: since,
      ...(limit === undefined ? {} : { limit }),
    })
    return events.map(toEventDto)
  })

  // `unknown` atravessa como `unknown`: a UI mostra `?`, nunca pinta de verde (DASHBOARD 5.1).
  app.get('/api/providers', async (): Promise<ProviderHealthDto[]> => {
    const health = await deps.plane.registry.health()
    return health.map(toProviderHealthDto)
  })

  app.get<{ Params: RunParams }>('/api/runs/:id/report', async (request, reply) => {
    const id = parseRunId(request.params.id)
    await loadRunOr404(deps, id)
    const report = await deps.plane.generateMissionReport(id)
    const query = request.query as Record<string, unknown>
    if (query.format === 'md' || query.format === 'markdown') {
      return reply.type('text/markdown; charset=utf-8').send(renderMissionReport(report))
    }
    return reply.send(report)
  })
}
