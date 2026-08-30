export const WORKSPACE_KINDS = ['shared', 'git-worktree'] as const
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number]

/** Onde a tentativa aconteceu. Responde "em qual worktree e branch?" sem ler log. */
export interface WorkspaceRef {
  readonly kind: WorkspaceKind
  readonly path: string
  readonly branch?: string
  readonly baseCommit?: string
}
