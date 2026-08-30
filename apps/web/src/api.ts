import {
  type ApproveMissionCommand,
  ApproveMissionCommandSchema,
  type CompileReportDto,
  CompileReportDtoSchema,
  type EventDto,
  EventDtoSchema,
  type ProviderHealthDto,
  ProviderHealthDtoSchema,
  type RetryTaskCommand,
  RetryTaskCommandSchema,
  type RunHeaderDto,
  RunHeaderSchema,
  type RunSnapshot,
  RunSnapshotSchema,
  type SkipTaskCommand,
  SkipTaskCommandSchema,
  type StartRunCommand,
  StartRunCommandSchema,
  type TaskDetail,
  TaskDetailSchema,
  type UnblockTaskCommand,
  UnblockTaskCommandSchema,
} from '@agentic/schemas'

/**
 * Cliente fino sobre o contrato de `@agentic/schemas`. Nao existe cliente gerado: o dashboard
 * usa os tipos do pacote direto (ARCHITECTURE 11). Toda resposta e validada pelo schema — o
 * que chega fora do contrato falha aqui, nao no meio da renderizacao.
 */
export const API_BASE = '/api'

export class ApiError extends Error {
  readonly status: number
  readonly detail: string

  constructor(status: number, detail: string) {
    super(`${status}: ${detail}`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText)
    throw new ApiError(response.status, detail || response.statusText)
  }
  if (response.status === 204) return undefined
  return response.json()
}

async function post(path: string, body: unknown): Promise<unknown> {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function listRuns(): Promise<readonly RunHeaderDto[]> {
  const raw = await request('/runs')
  const list = Array.isArray(raw) ? raw : ((raw as { runs?: unknown })?.runs ?? [])
  return RunHeaderSchema.array().parse(list)
}

export async function getRunSnapshot(runId: string): Promise<RunSnapshot> {
  return RunSnapshotSchema.parse(await request(`/runs/${encodeURIComponent(runId)}/snapshot`))
}

export async function getTaskDetail(runId: string, taskId: string): Promise<TaskDetail> {
  const path = `/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}`
  return TaskDetailSchema.parse(await request(path))
}

export async function getEvents(runId: string, since: number): Promise<readonly EventDto[]> {
  const path = `/runs/${encodeURIComponent(runId)}/events?since=${since}`
  const raw = await request(path)
  const list = Array.isArray(raw) ? raw : ((raw as { events?: unknown })?.events ?? [])
  return EventDtoSchema.array().parse(list)
}

/** SSE a partir do ultimo `seq` visto: reconexao retoma sem lacuna e sem duplicata. */
export function streamUrl(runId: string, since: number): string {
  return `${API_BASE}/runs/${encodeURIComponent(runId)}/stream?since=${since}`
}

export async function getCompileReport(missionId: string): Promise<CompileReportDto> {
  const path = `/missions/${encodeURIComponent(missionId)}/compile`
  return CompileReportDtoSchema.parse(await request(path))
}

export async function getProviders(): Promise<readonly ProviderHealthDto[]> {
  const raw = await request('/providers')
  const list = Array.isArray(raw) ? raw : ((raw as { providers?: unknown })?.providers ?? [])
  return ProviderHealthDtoSchema.array().parse(list)
}

/** Aprovar e ato humano registrado com `actor` (DASHBOARD 7). */
export async function approveMission(
  missionId: string,
  command: ApproveMissionCommand,
): Promise<void> {
  const body = ApproveMissionCommandSchema.parse(command)
  await post(`/missions/${encodeURIComponent(missionId)}/approve`, body)
}

/** START MISSION. Um clique: o orquestrador descobre as `READY` (DASHBOARD 2.1). */
export async function startRun(command: StartRunCommand): Promise<string> {
  const body = StartRunCommandSchema.parse(command)
  const raw = (await post('/runs', body)) as { runId?: unknown; id?: unknown } | undefined
  const runId = raw?.runId ?? raw?.id
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new ApiError(502, 'resposta de POST /api/runs sem runId')
  }
  return runId
}

export async function pauseRun(runId: string): Promise<void> {
  await post(`/runs/${encodeURIComponent(runId)}/pause`, {})
}

export async function resumeRun(runId: string): Promise<void> {
  await post(`/runs/${encodeURIComponent(runId)}/resume`, {})
}

function taskPath(runId: string, taskId: string, action: string): string {
  return `/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/${action}`
}

export async function retryTask(runId: string, command: RetryTaskCommand): Promise<void> {
  const body = RetryTaskCommandSchema.parse(command)
  await post(taskPath(runId, body.taskId, 'retry'), body)
}

/** `unblock` exige nota; `skip` exige motivo. Atrito deliberado (DASHBOARD 7). */
export async function unblockTask(runId: string, command: UnblockTaskCommand): Promise<void> {
  const body = UnblockTaskCommandSchema.parse(command)
  await post(taskPath(runId, body.taskId, 'unblock'), body)
}

export async function skipTask(runId: string, command: SkipTaskCommand): Promise<void> {
  const body = SkipTaskCommandSchema.parse(command)
  await post(taskPath(runId, body.taskId, 'skip'), body)
}
