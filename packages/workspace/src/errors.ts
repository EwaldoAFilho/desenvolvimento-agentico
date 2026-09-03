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
  /** O grupo de processos de um comando ainda existia quando o teto venceu (I15). */
  readonly residualProcess?: boolean
  /** Pid do lider desse comando: o grupo (`-pid`) que quem encerra precisa sondar de novo. */
  readonly residualGroup?: number
}

/**
 * Preparar a arvore e a integracao nunca se confundem com reprovar no gate: tudo que falha
 * aqui vira `WORKSPACE_ERROR` (ARCHITECTURE 5.2).
 */
export class WorkspaceError extends Error {
  readonly code: FailureCode = 'WORKSPACE_ERROR'
  readonly stage: WorkspaceStage
  readonly detail: string | undefined
  readonly residualProcess: boolean
  readonly residualGroup: number | undefined

  constructor(stage: WorkspaceStage, message: string, options: WorkspaceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = new.target.name
    this.stage = stage
    this.detail = options.detail
    this.residualProcess = options.residualProcess === true
    this.residualGroup = options.residualGroup
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

/** Falha que deixou processo vivo atras de si: quem encerra nao pode presumir que parou. */
export function isResidualProcessError(value: unknown): boolean {
  return isWorkspaceError(value) && value.residualProcess
}

/** O pid do lider do grupo que ficou vivo, quando a falha e dessas; senao `undefined`. */
export function residualGroupOf(value: unknown): number | undefined {
  return isWorkspaceError(value) && value.residualProcess ? value.residualGroup : undefined
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
