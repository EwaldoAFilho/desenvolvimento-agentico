import { mkdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type {
  AttemptId,
  CommitRef,
  MissionId,
  PathScope,
  RunId,
  Workspace,
  WorkspaceDisposition,
  WorkspaceProvider,
} from '@agentic/domain'
import type { AttemptObservation, WorkspaceScope } from './diff.js'
import { WorkspaceError } from './errors.js'
import { Mutex } from './lease.js'
import {
  attemptWorktreePath,
  DEFAULT_MISSION_BRANCH_PREFIX,
  DEFAULT_TASK_BRANCH_PREFIX,
  DEFAULT_WORKTREE_ROOT,
  missionBranchName,
  resolveAttemptNumber,
  taskBranchName,
} from './naming.js'
import { type AttemptCommit, commitWorkingTree, observeWorkingTree } from './ops.js'
import { addWorktree, addWorktreeForBranch, ensureBranch, removeWorktree } from './repo.js'
import {
  EMPTY_SETUP_RESULT,
  runWorkspaceSetup,
  type WorkspaceSetup,
  type WorkspaceSetupResult,
} from './setup.js'
import type { AttemptLease } from './types.js'

export interface GitWorktreeProviderConfig {
  readonly repoRoot: string
  readonly missionId: MissionId
  /** Default `.agentic/worktrees`, relativo a raiz do repositorio. */
  readonly worktreeRoot?: string
  /** De onde a branch da missao nasce quando ainda nao existe. Default `HEAD`. */
  readonly missionBase?: string
  readonly missionBranchPrefix?: string
  readonly taskBranchPrefix?: string
  readonly workspaceSetup?: WorkspaceSetup
  readonly denyPaths?: readonly PathScope[]
  /** Escopo usado quando o lease nao declara `touches`. */
  readonly touches?: readonly PathScope[]
}

export interface MissionWorkspaceRequest {
  readonly runId: RunId
  readonly attemptId: AttemptId
  readonly missionId?: MissionId
}

interface LeaseState {
  readonly workspace: Workspace
  readonly scope: WorkspaceScope
  readonly links: readonly string[]
  readonly setup: WorkspaceSetupResult
}

/** Uma worktree por TENTATIVA, em branch propria a partir da branch da missao (ADR-0007). */
export class GitWorktreeWorkspaceProvider implements WorkspaceProvider {
  readonly #config: GitWorktreeProviderConfig
  readonly #repoRoot: string
  readonly #worktreeRoot: string
  readonly #leases = new Map<string, LeaseState>()
  readonly #mutex = new Mutex()

  constructor(config: GitWorktreeProviderConfig) {
    this.#config = config
    this.#repoRoot = resolve(config.repoRoot)
    const root = config.worktreeRoot ?? DEFAULT_WORKTREE_ROOT
    this.#worktreeRoot = isAbsolute(root) ? root : resolve(this.#repoRoot, root)
  }

  get repoRoot(): string {
    return this.#repoRoot
  }

  get worktreeRoot(): string {
    return this.#worktreeRoot
  }

  missionBranch(missionId: MissionId = this.#config.missionId): string {
    return missionBranchName(
      missionId,
      this.#config.missionBranchPrefix ?? DEFAULT_MISSION_BRANCH_PREFIX,
    )
  }

  /** Cria a branch da missao se nao existir. Idempotente. */
  ensureMissionBranch(missionId?: MissionId, base?: string): Promise<CommitRef> {
    return this.#mutex.run(() =>
      ensureBranch(
        this.#repoRoot,
        this.missionBranch(missionId ?? this.#config.missionId),
        base ?? this.#config.missionBase ?? 'HEAD',
      ),
    )
  }

  acquire(lease: AttemptLease): Promise<Workspace> {
    return this.#mutex.run(() => this.#acquire(lease))
  }

  /** Worktree da branch da missao, com o mesmo workspaceSetup: e onde o mission gate roda. */
  acquireMissionWorkspace(request: MissionWorkspaceRequest): Promise<Workspace> {
    return this.#mutex.run(() => this.#acquireMission(request))
  }

  async diff(ws: Workspace): Promise<AttemptObservation> {
    const state = this.#stateOf(ws, 'diff')
    const baseCommit = ws.baseCommit ?? state.workspace.baseCommit
    if (baseCommit === undefined) {
      throw new WorkspaceError('diff', 'workspace sem commit base', { detail: ws.id })
    }
    return observeWorkingTree({
      cwd: state.workspace.path,
      baseCommit,
      scope: state.scope,
      links: state.links,
    })
  }

  async commit(ws: Workspace, message: string): Promise<AttemptCommit> {
    const state = this.#stateOf(ws, 'commit')
    return commitWorkingTree({
      cwd: state.workspace.path,
      message,
      scope: state.scope,
      links: state.links,
      branch: state.workspace.branch,
    })
  }

  async release(ws: Workspace, disposition: WorkspaceDisposition): Promise<void> {
    const state = this.#leases.get(ws.id)
    const path = state?.workspace.path ?? ws.path
    this.#leases.delete(ws.id)
    // `keep` preserva a worktree para pericia; o lease cai nos dois casos.
    if (disposition === 'discard') await removeWorktree(this.#repoRoot, path)
  }

  setupOf(ws: Workspace): WorkspaceSetupResult | undefined {
    return this.#leases.get(ws.id)?.setup
  }

  #stateOf(ws: Workspace, stage: 'diff' | 'commit'): LeaseState {
    const state = this.#leases.get(ws.id)
    if (state === undefined) {
      throw new WorkspaceError(stage, 'workspace sem lease ativo neste provider', {
        detail: ws.id,
      })
    }
    return state
  }

  #scopeOf(lease: AttemptLease): WorkspaceScope {
    return {
      touches: lease.touches ?? this.#config.touches ?? [],
      denyPaths: lease.denyPaths ?? this.#config.denyPaths ?? [],
    }
  }

  async #acquire(lease: AttemptLease): Promise<Workspace> {
    if (lease.kind !== 'git-worktree') {
      throw new WorkspaceError('acquire', `lease pede workspace ${lease.kind} neste provider`, {
        detail: 'GitWorktreeWorkspaceProvider so atende kind git-worktree',
      })
    }
    const missionId = lease.missionId ?? this.#config.missionId
    const attemptNumber = resolveAttemptNumber(lease.attemptNumber, lease.attemptId)
    const branch =
      lease.branch ??
      taskBranchName(
        missionId,
        lease.taskId,
        attemptNumber,
        this.#config.taskBranchPrefix ?? DEFAULT_TASK_BRANCH_PREFIX,
      )
    const path = attemptWorktreePath(this.#worktreeRoot, lease.runId, lease.taskId, attemptNumber)
    const id = `${lease.runId}/${lease.taskId}-a${attemptNumber}`

    await this.#assertFreePath(path)
    const mission = await ensureBranch(
      this.#repoRoot,
      this.missionBranch(missionId),
      this.#config.missionBase ?? 'HEAD',
    )
    const baseCommit = lease.baseCommit ?? mission.sha
    await mkdir(dirname(path), { recursive: true })
    await addWorktree(this.#repoRoot, path, branch, baseCommit)

    const workspace: Workspace = {
      id,
      kind: 'git-worktree',
      path,
      branch,
      baseCommit,
      leasedBy: lease.attemptId,
    }
    const setup = await this.#setupOrCleanup(path)
    this.#leases.set(id, {
      workspace,
      scope: this.#scopeOf(lease),
      links: setup.linked,
      setup,
    })
    return workspace
  }

  async #acquireMission(request: MissionWorkspaceRequest): Promise<Workspace> {
    const missionId = request.missionId ?? this.#config.missionId
    const branch = this.missionBranch(missionId)
    const mission = await ensureBranch(this.#repoRoot, branch, this.#config.missionBase ?? 'HEAD')
    const path = resolve(this.#worktreeRoot, request.runId, 'mission')
    const id = `${request.runId}/mission`
    await this.#assertFreePath(path)
    await mkdir(dirname(path), { recursive: true })
    await addWorktreeForBranch(this.#repoRoot, path, branch, 'acquire')
    const workspace: Workspace = {
      id,
      kind: 'git-worktree',
      path,
      branch,
      baseCommit: mission.sha,
      leasedBy: request.attemptId,
    }
    const setup = await this.#setupOrCleanup(path)
    this.#leases.set(id, {
      workspace,
      scope: { touches: [], denyPaths: this.#config.denyPaths ?? [] },
      links: setup.linked,
      setup,
    })
    return workspace
  }

  async #assertFreePath(path: string): Promise<void> {
    const existing = await stat(path).catch(() => null)
    if (existing !== null) {
      throw new WorkspaceError('acquire', 'caminho de worktree ja existe', { detail: path })
    }
  }

  /**
   * Worktree sem setup e worktree inutil: se o setup falhar, ela sai do disco para que a
   * proxima tentativa possa recriar, e o erro sobe como WORKSPACE_ERROR.
   */
  async #setupOrCleanup(path: string): Promise<WorkspaceSetupResult> {
    if (this.#config.workspaceSetup === undefined) return EMPTY_SETUP_RESULT
    try {
      return await runWorkspaceSetup(path, this.#repoRoot, this.#config.workspaceSetup)
    } catch (error) {
      await removeWorktree(this.#repoRoot, path).catch(() => undefined)
      throw error
    }
  }
}
