import { DomainError } from '@agentic/domain'
import { OrchestratorError } from '@agentic/orchestrator'
import type { DiagnosticDto } from '@agentic/schemas'
import { formatIssuePath } from '@agentic/schemas'
import type { FastifyInstance } from 'fastify'

export interface ApiIssue {
  readonly path: string
  readonly message: string
}

/**
 * Erro na fronteira HTTP. O corpo carrega SEMPRE um codigo estavel; `diagnostics` aparece
 * quando a recusa vem do compilador — o dashboard mostra a lista, nao uma frase solta.
 */
export interface ApiErrorPayload {
  readonly code: string
  readonly message: string
  readonly diagnostics?: readonly DiagnosticDto[]
  readonly issues?: readonly ApiIssue[]
}

export interface ApiErrorBody {
  readonly error: ApiErrorPayload
}

export interface HttpErrorExtra {
  readonly diagnostics?: readonly DiagnosticDto[]
  readonly issues?: readonly ApiIssue[]
}

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly diagnostics: readonly DiagnosticDto[] | undefined
  readonly issues: readonly ApiIssue[] | undefined

  constructor(status: number, code: string, message: string, extra: HttpErrorExtra = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.diagnostics = extra.diagnostics
    this.issues = extra.issues
  }
}

export function badRequest(code: string, message: string, extra?: HttpErrorExtra): HttpError {
  return new HttpError(400, code, message, extra)
}

export function notFound(code: string, message: string): HttpError {
  return new HttpError(404, code, message)
}

export function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message)
}

/** Issues do zod viram dado: caminho legivel + mensagem, sem vazar a forma do validador. */
export function toApiIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): ApiIssue[] {
  return issues.map((issue) => ({
    path: formatIssuePath(
      issue.path.filter((part): part is string | number => typeof part !== 'symbol'),
    ),
    message: issue.message,
  }))
}

const STATUS_BY_ORCHESTRATOR_CODE: Readonly<Record<string, number>> = {
  RUN_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  COMMAND_REFUSED: 400,
}

const STATUS_BY_DOMAIN_CODE: Readonly<Record<string, number>> = {
  INVALID_ID: 400,
  INVALID_PATH_SCOPE: 400,
  INVALID_TRANSITION: 409,
  UNRESOLVED_REVIEW_POLICY: 409,
}

export interface ApiErrorResponse {
  readonly status: number
  readonly body: ApiErrorBody
}

/** Traducao unica de excecao para resposta. Nenhuma rota monta corpo de erro por conta. */
export function toApiError(error: unknown): ApiErrorResponse {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }),
          ...(error.issues === undefined ? {} : { issues: error.issues }),
        },
      },
    }
  }
  if (error instanceof OrchestratorError) {
    return {
      status: STATUS_BY_ORCHESTRATOR_CODE[error.code] ?? 409,
      body: { error: { code: error.code, message: error.message } },
    }
  }
  if (error instanceof DomainError) {
    return {
      status: STATUS_BY_DOMAIN_CODE[error.code] ?? 409,
      body: { error: { code: error.code, message: error.message } },
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message } } }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    const mapped = toApiError(error)
    return reply.status(mapped.status).send(mapped.body)
  })
}
