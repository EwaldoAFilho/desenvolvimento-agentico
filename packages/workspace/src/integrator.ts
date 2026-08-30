import { mkdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import {
  type Attempt,
  type CommitRef,
  type IntegrationResult,
  type Integrator,
  type MissionId,
  parseTaskRunId,
} from '@agentic/domain'
import { WorkspaceError } from './errors.js'
import { git, gitText } from './git.js'
import { Mutex } from './lease.js'
import {
  DEFAULT_MISSION_BRANCH_PREFIX,
  DEFAULT_TASK_BRANCH_PREFIX,
  DEFAULT_WORKTREE_ROOT,
  missionBranchName,
  slugifyBranch,
  taskBranchName,
} from './naming.js'
import {
  addWorktreeForBranch,
  branchExists,
  ensureBranch,
  fastForwardBranch,
  isAncestor,
  removeWorktree,
  revParse,
  unmergedPaths,
  worktreeOnBranch,
} from './repo.js'

export interface GitIntegratorConfig {
  readonly repoRoot: string
  readonly missionId: MissionId
  readonly worktreeRoot?: string
  readonly missionBase?: string
  readonly missionBranchPrefix?: string
  readonly taskBranchPrefix?: string
}

interface Checkout {
  readonly path: string
  readonly temporary: boolean
}

/**
 * Rebase da branch da tentativa sobre a branch da missao + fast-forward (ADR-0007).
 * Conflito e estado previsto, nao excecao: vira `INTEGRATION_CONFLICT` retentavel.
 */
export class GitIntegrator implements Integrator {
  readonly #config: GitIntegratorConfig
  readonly #repoRoot: string
  readonly #worktreeRoot: string
  readonly #mutex = new Mutex()

  constructor(config: GitIntegratorConfig) {
    this.#config = config
    this.#repoRoot = resolve(config.repoRoot)
    const root = config.worktreeRoot ?? DEFAULT_WORKTREE_ROOT
    this.#worktreeRoot = isAbsolute(root) ? root : resolve(this.#repoRoot, root)
  }

  missionBranch(missionId: MissionId = this.#config.missionId): string {
    return missionBranchName(
      missionId,
      this.#config.missionBranchPrefix ?? DEFAULT_MISSION_BRANCH_PREFIX,
    )
  }

  ensureMissionBranch(missionId?: MissionId, base?: string): Promise<CommitRef> {
    return this.#mutex.run(() =>
      ensureBranch(
        this.#repoRoot,
        this.missionBranch(missionId ?? this.#config.missionId),
        base ?? this.#config.missionBase ?? 'HEAD',
      ),
    )
  }

  /** Serializado: duas integracoes concorrentes na mesma branch da missao viram fila. */
  integrate(attempt: Attempt): Promise<IntegrationResult> {
    return this.#mutex.run(() => this.#integrate(attempt))
  }

  #taskBranchOf(attempt: Attempt): string {
    if (attempt.workspace.branch !== undefined) return attempt.workspace.branch
    const { task } = parseTaskRunId(attempt.taskRunId)
    return taskBranchName(
      this.#config.missionId,
      task,
      attempt.attemptNumber,
      this.#config.taskBranchPrefix ?? DEFAULT_TASK_BRANCH_PREFIX,
    )
  }

  async #integrate(attempt: Attempt): Promise<IntegrationResult> {
    const missionBranch = this.missionBranch()
    const taskBranch = this.#taskBranchOf(attempt)
    if (!(await branchExists(this.#repoRoot, taskBranch))) {
      throw new WorkspaceError('integrate', 'branch da tentativa nao existe', {
        detail: taskBranch,
      })
    }
    await ensureBranch(
      this.#repoRoot,
      missionBranch,
      this.#config.missionBase ?? 'HEAD',
      'integrate',
    )

    const checkout = await this.#checkoutFor(taskBranch)
    try {
      const rebase = await git(['rebase', missionBranch], {
        cwd: checkout.path,
        allowFailure: true,
        stage: 'integrate',
      })
      if (rebase.exitCode !== 0) {
        const conflicts = await unmergedPaths(checkout.path)
        // Abortar antes de qualquer coisa: a branch da missao nao pode ficar suja.
        await git(['rebase', '--abort'], {
          cwd: checkout.path,
          allowFailure: true,
          stage: 'integrate',
        })
        if (conflicts.length === 0) {
          throw new WorkspaceError('integrate', 'rebase falhou sem conflito de conteudo', {
            detail: (rebase.stderr || rebase.stdout).trim(),
          })
        }
        return {
          status: 'CONFLICT',
          conflicts,
          detail: `rebase de ${taskBranch} sobre ${missionBranch} conflitou`,
        }
      }

      const taskSha = await revParse(checkout.path, 'HEAD', 'integrate')
      const missionSha = await revParse(this.#repoRoot, missionBranch, 'integrate')
      if (taskSha === missionSha) {
        return { status: 'SKIPPED', detail: 'nada a integrar apos o rebase' }
      }
      if (!(await isAncestor(this.#repoRoot, missionSha, taskSha))) {
        throw new WorkspaceError('integrate', 'rebase nao deixou a missao como ancestral', {
          detail: `${missionBranch}=${missionSha} ${taskBranch}=${taskSha}`,
        })
      }
      await fastForwardBranch(this.#repoRoot, missionBranch, taskSha, missionSha)
      const message = await gitText(['log', '-1', '--format=%s', taskSha], {
        cwd: this.#repoRoot,
        stage: 'integrate',
      })
      return { status: 'MERGED', commit: { sha: taskSha, branch: missionBranch, message } }
    } finally {
      if (checkout.temporary) await removeWorktree(this.#repoRoot, checkout.path)
    }
  }

  /**
   * O rebase precisa de arvore. Normalmente e a propria worktree da tentativa; se ela ja
   * foi descartada, uma worktree temporaria faz o trabalho e some depois.
   */
  async #checkoutFor(taskBranch: string): Promise<Checkout> {
    const holder = await worktreeOnBranch(this.#repoRoot, taskBranch)
    if (holder !== undefined) {
      if ((await stat(holder.path).catch(() => null)) !== null) {
        return { path: holder.path, temporary: false }
      }
      // Registro obsoleto: sem podar, `worktree add` recusaria a branch como ja aberta.
      await removeWorktree(this.#repoRoot, holder.path)
    }
    const path = resolve(this.#worktreeRoot, '.integration', slugifyBranch(taskBranch))
    await mkdir(dirname(path), { recursive: true })
    await removeWorktree(this.#repoRoot, path)
    await addWorktreeForBranch(this.#repoRoot, path, taskBranch)
    return { path, temporary: true }
  }
}
