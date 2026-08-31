import {
  type ApproveMissionCommand,
  ApproveMissionCommandSchema,
  type CompileReportDto,
  CompileReportDtoSchema,
  type EventDto,
  EventDtoSchema,
  type ProjectHomeDto,
  ProjectHomeDtoSchema,
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

/** O corpo de erro do control plane carrega SEMPRE um codigo estavel em `error.code`. */
function apiPayloadOf(detail: string): { code?: string; message?: string } | undefined {
  try {
    const body = JSON.parse(detail) as { error?: { code?: unknown; message?: unknown } }
    const error = body?.error
    if (error === undefined || error === null) return undefined
    return {
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      ...(typeof error.message === 'string' ? { message: error.message } : {}),
    }
  } catch {
    return undefined
  }
}

const FAILURE_MAX = 300

/**
 * Falha virada em frase que a tela pode mostrar ao lado do botao de tentar novamente. O
 * codigo do control plane vem junto de proposito: `MISSIONS_DIR_UNREADABLE` diz o que
 * consertar, "erro ao carregar" nao diz nada. Corpo enorme (HTML de proxy, stack) e cortado
 * — a mensagem e para ler, o diagnostico completo esta no servidor.
 */
export function describeFailure(cause: unknown): string {
  if (cause instanceof ApiError) {
    const payload = apiPayloadOf(cause.detail)
    const text = payload?.message ?? cause.detail
    const code = payload?.code === undefined ? '' : ` ${payload.code}`
    const body = text.length > FAILURE_MAX ? `${text.slice(0, FAILURE_MAX - 1)}…` : text
    return `HTTP ${cause.status}${code}: ${body}`
  }
  const text = cause instanceof Error ? cause.message : String(cause)
  return text.length > FAILURE_MAX ? `${text.slice(0, FAILURE_MAX - 1)}…` : text
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

/**
 * Identidade do projeto, ambiente, missoes e execucoes numa leitura so. A Home NAO encadeia
 * tres chamadas para desenhar a primeira tela — e responde com o projeto vazio, sem nenhum
 * run criado, que e justamente o caso que ficava carregando para sempre.
 */
export async function getProjectHome(limit?: number): Promise<ProjectHomeDto> {
  const query = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`
  return ProjectHomeDtoSchema.parse(await request(`/project${query}`))
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
