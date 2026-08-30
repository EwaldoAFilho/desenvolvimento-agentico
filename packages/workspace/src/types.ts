import type { MissionId, PathScope, WorkspaceLeaseRequest } from '@agentic/domain'

/**
 * O que a porta nao carrega e o adapter de git precisa: numero da tentativa (nome da
 * branch), missao e o escopo declarado da task. Tudo opcional — um `WorkspaceLeaseRequest`
 * puro continua valido.
 */
export interface AttemptLease extends WorkspaceLeaseRequest {
  readonly missionId?: MissionId
  readonly attemptNumber?: number
  readonly touches?: readonly PathScope[]
  readonly denyPaths?: readonly PathScope[]
}
