import type { Observation } from '../evidence.js'
import type { AttemptId, RunId, TaskId } from '../ids.js'
import type { CommitRef } from '../integration.js'
import type { WorkspaceKind } from '../workspace.js'

export interface Workspace {
  readonly id: string
  readonly kind: WorkspaceKind
  readonly path: string
  readonly branch?: string
  readonly baseCommit?: string
  readonly leasedBy: AttemptId
}

export interface WorkspaceLeaseRequest {
  readonly runId: RunId
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly kind: WorkspaceKind
  readonly branch?: string
  readonly baseCommit?: string
}

export type WorkspaceDisposition = 'keep' | 'discard'

/** Porta: `shared` e `git-worktree` sao adapters, vivem fora do dominio (ADR-0007). */
export interface WorkspaceProvider {
  acquire(lease: WorkspaceLeaseRequest): Promise<Workspace>
  diff(ws: Workspace): Promise<Observation>
  commit(ws: Workspace, message: string): Promise<CommitRef>
  release(ws: Workspace, disposition: WorkspaceDisposition): Promise<void>
}
