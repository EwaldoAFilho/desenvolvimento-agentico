import type { FailureCode, FailureReason } from '@agentic/domain'

export const WORKSPACE_STAGES = [
  'acquire',
  'setup',
  'diff',
  'commit',
  'release',
  'integrate',
] as const

export type WorkspaceStage = (typeof WORKSPACE_STAGES)[number]

export interface WorkspaceErrorOptions {
  readonly detail?: string
  readonly cause?: unknown
}

/**
 * Preparar a arvore e a integracao nunca se confundem com reprovar no gate: tudo que falha
 * aqui vira `WORKSPACE_ERROR` (ARCHITECTURE 5.2).
 */
export class WorkspaceError extends Error {
  readonly code: FailureCode = 'WORKSPACE_ERROR'
  readonly stage: WorkspaceStage
  readonly detail: string | undefined

  constructor(stage: WorkspaceStage, message: string, options: WorkspaceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = new.target.name
    this.stage = stage
    this.detail = options.detail
  }

  toFailureReason(): FailureReason {
    const detail = this.detail === undefined ? this.message : `${this.message}: ${this.detail}`
    return { code: this.code, detail }
  }
}

/** Segundo lease de escrita na arvore compartilhada. Explicito, nunca silencioso. */
export class WorkspaceBusyError extends WorkspaceError {
  constructor(message: string, options: WorkspaceErrorOptions = {}) {
    super('acquire', message, options)
  }
}

export function isWorkspaceError(value: unknown): value is WorkspaceError {
  return value instanceof WorkspaceError
}

export function isWorkspaceBusyError(value: unknown): value is WorkspaceBusyError {
  return value instanceof WorkspaceBusyError
}

/** Qualquer falha deste pacote e traduzida para o codigo fechado do dominio. */
export function toFailureReason(value: unknown): FailureReason {
  if (isWorkspaceError(value)) return value.toFailureReason()
  const detail = value instanceof Error ? value.message : String(value)
  return { code: 'WORKSPACE_ERROR', detail }
}
