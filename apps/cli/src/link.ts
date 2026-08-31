import type { ProjectFile } from '@agentic/schemas'

/**
 * Ligacao com o control plane NO AR (ARCHITECTURE 4). Comando de mutacao sobre um run vai
 * por HTTP local: quem escreve estado continua sendo um unico processo (I7). Se nao houver
 * processo, a CLI diz isso em vez de escrever no banco por fora.
 */
export interface LinkRequest {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly body?: unknown
}

export interface LinkResponse {
  readonly status: number
  readonly body: unknown
}

export interface ControlPlaneLink {
  readonly endpoint: string
  send(request: LinkRequest): Promise<LinkResponse>
}

export function endpointOf(project: ProjectFile, port?: number): string {
  const host = project.server.host
  return `http://${host}:${port ?? project.server.port}`
}

/** Erro de transporte vira mensagem, nunca stack: a CLI e a fronteira com o humano. */
export class LinkError extends Error {
  readonly code = 'CONTROL_PLANE_REFUSED'
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'LinkError'
    this.status = status
  }
}

const PROBE_TIMEOUT_MS = 750

/** Identidade que o nosso `/api/health` devolve. Porta ocupada nao e control plane. */
export const CONTROL_PLANE_SERVICE = '@agentic/server'

/**
 * Sonda o endereco descoberto (ou o declarado em `project.yaml`). `undefined` significa
 * "nao ha control plane no ar" — nao significa "pode escrever".
 *
 * A sonda pergunta QUEM atende, nao apenas SE atende: qualquer processo pode estar na porta
 * declarada e responder 404. Tratar um estranho como control plane troca a mensagem que diz
 * o caminho de volta por um `HTTP 404` que nao explica nada.
 */
export async function connectHttp(endpoint: string): Promise<ControlPlaneLink | undefined> {
  try {
    const response = await fetch(`${endpoint}/api/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { readonly service?: unknown }
    if (body.service !== CONTROL_PLANE_SERVICE) return undefined
  } catch {
    return undefined
  }
  return httpLink(endpoint)
}

export function httpLink(endpoint: string): ControlPlaneLink {
  return {
    endpoint,
    send: async (request: LinkRequest): Promise<LinkResponse> => {
      const response = await fetch(`${endpoint}${request.path}`, {
        method: request.method,
        headers: request.body === undefined ? {} : { 'content-type': 'application/json' },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      })
      const text = await response.text()
      const body: unknown = text.length === 0 ? undefined : safeJson(text)
      if (!response.ok) {
        throw new LinkError(response.status, detailOf(body) ?? `HTTP ${response.status}`)
      }
      return { status: response.status, body }
    },
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function detailOf(body: unknown): string | undefined {
  if (typeof body === 'string' && body.length > 0) return body
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>
    // O servidor responde `{ error: { code, message } }`. Sem abrir o envelope, o humano
    // recebia `HTTP 404` no lugar de "run ... nao existe".
    const nested = record.error
    if (typeof nested === 'object' && nested !== null) {
      const detail = (nested as Record<string, unknown>).message
      if (typeof detail === 'string' && detail.length > 0) return detail
    }
    const message = record.message ?? record.error ?? record.detail
    if (typeof message === 'string') return message
  }
  return undefined
}
