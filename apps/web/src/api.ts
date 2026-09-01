import {
  type ApproveMissionCommand,
  ApproveMissionCommandSchema,
  type CompileReportDto,
  CompileReportDtoSchema,
  type CreateDraftCommand,
  CreateDraftCommandSchema,
  type CreateDraftResultDto,
  CreateDraftResultDtoSchema,
  type EventDto,
  EventDtoSchema,
  type MissionSummaryDto,
  MissionSummaryDtoSchema,
  type PlanMissionCommand,
  PlanMissionCommandSchema,
  type PlanMissionResultDto,
  PlanMissionResultDtoSchema,
  type PlannerDto,
  PlannerDtoSchema,
  type PlanningFailureDto,
  PlanningFailureDtoSchema,
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

/**
 * As missoes do projeto como arquivo: e daqui que sai o CAMINHO do YAML, o unico ajuste de
 * plano que a interface oferece (DASHBOARD 7 — editar missao pela UI esta fora do MVP).
 */
export async function getMissions(): Promise<readonly MissionSummaryDto[]> {
  const raw = await request('/missions')
  const list = Array.isArray(raw) ? raw : ((raw as { missions?: unknown })?.missions ?? [])
  return MissionSummaryDtoSchema.array().parse(list)
}

/**
 * Rascunho: compila, CONGELA o grafo e para — nao aprova e nao parte (P15). E o que da a esta
 * tela um DAG para revisar antes de decidir. Idempotente por versao do plano: o mesmo
 * `specHash` devolve o mesmo run, entao pedir duas vezes nao cria dois — e um YAML editado
 * devolve outro rascunho, que e justamente o que impede a tela de desenhar um plano velho.
 */
export async function createMissionDraft(
  command: CreateDraftCommand,
): Promise<CreateDraftResultDto> {
  const body = CreateDraftCommandSchema.parse(command)
  return CreateDraftResultDtoSchema.parse(await post('/missions/draft', body))
}

export async function getProviders(): Promise<readonly ProviderHealthDto[]> {
  const raw = await request('/providers')
  const list = Array.isArray(raw) ? raw : ((raw as { providers?: unknown })?.providers ?? [])
  return ProviderHealthDtoSchema.array().parse(list)
}

/**
 * Quem pode planejar. Nao sai de `GET /api/project`: planejar e outra porta (ADR-0013) e a
 * lista dela tem endereco proprio — duas leituras da mesma coisa divergem, e a divergencia
 * apareceria como um planejador oferecido de um lado e ausente do outro.
 */
export async function getPlanners(): Promise<readonly PlannerDto[]> {
  const raw = await request('/planners')
  const list = Array.isArray(raw) ? raw : ((raw as { planners?: unknown })?.planners ?? [])
  return PlannerDtoSchema.array().parse(list)
}

/**
 * Planejamento que nao deu certo e DIAGNOSTICO, nao erro de protocolo: o control plane
 * responde 422/503/504 com o proprio `PlanningFailureDto` no corpo. Recusa de outra natureza
 * (comando invalido, control plane sem planejamento) tem outro corpo e nao casa aqui — o
 * schema e `strict`, entao `{ error: … }` nao passa por diagnostico de plano.
 */
export function planningFailureOf(cause: unknown): PlanningFailureDto | undefined {
  if (!(cause instanceof ApiError)) return undefined
  try {
    const parsed = PlanningFailureDtoSchema.safeParse(JSON.parse(cause.detail))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** Duas saidas, as duas terminais: o rascunho nasceu, ou ha um motivo legivel para nao ter. */
export type PlanOutcome =
  | { readonly kind: 'planned'; readonly result: PlanMissionResultDto }
  | { readonly kind: 'refused'; readonly failure: PlanningFailureDto }

/**
 * Texto livre vira missao gravada, compilada e um run `DRAFT`. Nada aqui aprova nem executa:
 * o proximo passo continua sendo humano (P15). `acceptsSubscriptionUse` viaja explicito
 * porque acionar fornecedor real gasta a assinatura do usuario (P17).
 */
export async function planMission(command: PlanMissionCommand): Promise<PlanOutcome> {
  const body = PlanMissionCommandSchema.parse(command)
  try {
    const raw = await post('/missions/plan', body)
    return { kind: 'planned', result: PlanMissionResultDtoSchema.parse(raw) }
  } catch (cause) {
    const failure = planningFailureOf(cause)
    if (failure === undefined) throw cause
    return { kind: 'refused', failure }
  }
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
