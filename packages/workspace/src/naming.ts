import { join } from 'node:path'

export const DEFAULT_MISSION_BRANCH_PREFIX = 'mission/'
export const DEFAULT_TASK_BRANCH_PREFIX = 'task/'
export const DEFAULT_WORKTREE_ROOT = '.agentic/worktrees'

export function missionBranchName(
  missionId: string,
  prefix: string = DEFAULT_MISSION_BRANCH_PREFIX,
): string {
  return `${prefix}${missionId}`
}

/** `task/<missionId>/<taskId>/a<N>` — uma branch por TENTATIVA (ADR-0007). */
export function taskBranchName(
  missionId: string,
  taskId: string,
  attemptNumber: number,
  prefix: string = DEFAULT_TASK_BRANCH_PREFIX,
): string {
  return `${prefix}${missionId}/${taskId}/a${attemptNumber}`
}

export function attemptDirName(taskId: string, attemptNumber: number): string {
  return `${taskId}-a${attemptNumber}`
}

/** `<worktreeRoot>/<runId>/<taskId>-a<N>` (ARCHITECTURE 5.2). */
export function attemptWorktreePath(
  worktreeRoot: string,
  runId: string,
  taskId: string,
  attemptNumber: number,
): string {
  return join(worktreeRoot, runId, attemptDirName(taskId, attemptNumber))
}

const TRAILING_ATTEMPT = /a(\d+)$/

/**
 * A porta nao carrega o numero da tentativa; quando o chamador nao informa, so o sufixo
 * `a<N>` do `attemptId` conta — id opaco terminado em digito nao vira numero de tentativa.
 */
export function resolveAttemptNumber(explicit: number | undefined, attemptId: string): number {
  if (typeof explicit === 'number' && Number.isInteger(explicit) && explicit > 0) return explicit
  const match = TRAILING_ATTEMPT.exec(attemptId)
  const parsed = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1
}

/** Nome de branch vira nome de diretorio sem `/`. */
export function slugifyBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-')
}
