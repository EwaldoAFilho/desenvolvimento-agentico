import type {
  CompileReportDto,
  HealthBody,
  MissionListItem,
  ProviderHealthDto,
  RunHeaderDto,
  RunSnapshot,
  TaskDetail,
} from './contracts.js'
import { PROJECT_HEADER } from './contracts.js'

/**
 * Cliente HTTP do control plane. Fino de proposito: a extensao consulta e comanda; quem
 * decide continua sendo o unico processo dono do estado (I7).
 *
 * Cada requisicao carrega o `repoRoot` do projeto no header de guarda: um control plane de
 * outro repositorio na mesma porta responde 409 em vez de agir no projeto errado.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class AgenticApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AgenticApiError'
    this.status = status
    this.code = code
  }
}

const REQUEST_TIMEOUT_MS = 10_000

export class AgenticClient {
  readonly baseUrl: string
  readonly repoRoot: string
  private readonly fetchFn: FetchLike

  constructor(baseUrl: string, repoRoot: string, fetchFn: FetchLike = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.repoRoot = repoRoot
    this.fetchFn = fetchFn
  }

  health(): Promise<HealthBody> {
    return this.get<HealthBody>('/api/health')
  }

  providers(): Promise<ProviderHealthDto[]> {
    return this.get<ProviderHealthDto[]>('/api/providers')
  }

  missions(): Promise<MissionListItem[]> {
    return this.get<MissionListItem[]>('/api/missions')
  }

  runs(limit = 50): Promise<RunHeaderDto[]> {
    return this.get<RunHeaderDto[]>(`/api/runs?limit=${limit}`)
  }

  run(runId: string): Promise<RunHeaderDto> {
    return this.get<RunHeaderDto>(`/api/runs/${encodeURIComponent(runId)}`)
  }

  snapshot(runId: string): Promise<RunSnapshot> {
    return this.get<RunSnapshot>(`/api/runs/${encodeURIComponent(runId)}/snapshot`)
  }

  task(runId: string, taskId: string): Promise<TaskDetail> {
    return this.get<TaskDetail>(
      `/api/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}`,
    )
  }

  /** `file` relativo ao `repoRoot`, como `GET /api/missions` devolve. */
  compile(file: string): Promise<CompileReportDto> {
    return this.get<CompileReportDto>(`/api/missions/compile?file=${encodeURIComponent(file)}`)
  }

  async get<T>(path: string): Promise<T> {
    return this.send<T>('GET', path)
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>('POST', path, body)
  }

  private async send<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { [PROJECT_HEADER]: this.repoRoot }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    let parsed: unknown
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }
    if (!response.ok) {
      const envelope = (parsed as { readonly error?: { code?: string; message?: string } }) ?? {}
      const error = envelope.error ?? {}
      throw new AgenticApiError(
        response.status,
        error.code ?? `HTTP_${response.status}`,
        error.message ?? `HTTP ${response.status} em ${method} ${path}`,
      )
    }
    return parsed as T
  }
}
