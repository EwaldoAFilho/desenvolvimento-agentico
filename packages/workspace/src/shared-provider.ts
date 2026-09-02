import { resolve } from 'node:path'
import type { PathScope, Workspace, WorkspaceDisposition, WorkspaceProvider } from '@agentic/domain'
import type { AttemptObservation, WorkspaceScope } from './diff.js'
import { WorkspaceError } from './errors.js'
import { type BusyPolicy, WriteGate } from './lease.js'
import { type AttemptCommit, commitWorkingTree, observeWorkingTree } from './ops.js'
import { currentBranch, isGitRepo, tryRevParse } from './repo.js'
import {
  EMPTY_SETUP_RESULT,
  runWorkspaceSetup,
  type SetupProcessDeps,
  type WorkspaceSetup,
  type WorkspaceSetupResult,
} from './setup.js'
import type { AttemptLease } from './types.js'

export interface SharedProviderConfig {
  /** A unica arvore. Default: a propria raiz do repositorio. */
  readonly root: string
  readonly repoRoot?: string
  /** `wait` enfileira o segundo lease; `fail` recusa na hora. Default `wait`. */
  readonly onBusy?: BusyPolicy
  readonly waitTimeoutMs?: number
  readonly workspaceSetup?: WorkspaceSetup
  /** Sonda e teto do grupo de processos dos comandos de `workspaceSetup` (injetavel no teste). */
  readonly setupProcessDeps?: SetupProcessDeps
  readonly denyPaths?: readonly PathScope[]
  readonly touches?: readonly PathScope[]
}

interface LeaseState {
  readonly workspace: Workspace
  readonly scope: WorkspaceScope
  readonly links: readonly string[]
  readonly setup: WorkspaceSetupResult
  readonly git: boolean
}

/**
 * Uma arvore so: sem isolamento fisico, o paralelismo de escrita e forcado a 1 (ADR-0007).
 * Existe para repositorio nao-git e para projeto que nao tolera worktree.
 */
export class SharedWorkspaceProvider implements WorkspaceProvider {
  readonly #config: SharedProviderConfig
  readonly #root: string
  readonly #repoRoot: string
  readonly #gate = new WriteGate()
  readonly #leases = new Map<string, LeaseState>()

  constructor(config: SharedProviderConfig) {
    this.#config = config
    this.#root = resolve(config.root)
    this.#repoRoot = resolve(config.repoRoot ?? config.root)
  }

  get path(): string {
    return this.#root
  }

  get busy(): boolean {
    return this.#gate.held
  }

  get waiting(): number {
    return this.#gate.waiting
  }

  async acquire(lease: AttemptLease): Promise<Workspace> {
    await this.#gate.acquire(this.#config.onBusy ?? 'wait', this.#config.waitTimeoutMs)
    try {
      return await this.#acquire(lease)
    } catch (error) {
      this.#gate.release()
      throw error
    }
  }

  async diff(ws: Workspace): Promise<AttemptObservation> {
    const state = this.#stateOf(ws, 'diff')
    const baseCommit = ws.baseCommit ?? state.workspace.baseCommit
    if (!state.git || baseCommit === undefined) {
      throw new WorkspaceError('diff', 'arvore compartilhada nao e repositorio git', {
        detail: 'sem git nao ha diff verificavel; use workspace git-worktree',
      })
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
    if (!state.git) {
      throw new WorkspaceError('commit', 'arvore compartilhada nao e repositorio git', {
        detail: 'sem git nao ha commit por tentativa',
      })
    }
    return commitWorkingTree({
      cwd: state.workspace.path,
      message,
      scope: state.scope,
      links: state.links,
      branch: state.workspace.branch,
    })
  }

  /** A arvore compartilhada nunca e removida: `discard` so devolve o lease. */
  async release(ws: Workspace, _disposition: WorkspaceDisposition): Promise<void> {
    if (!this.#leases.has(ws.id)) return
    this.#leases.delete(ws.id)
    this.#gate.release()
  }

  setupOf(ws: Workspace): WorkspaceSetupResult | undefined {
    return this.#leases.get(ws.id)?.setup
  }

  #stateOf(ws: Workspace, stage: 'diff' | 'commit'): LeaseState {
    const state = this.#leases.get(ws.id)
    if (state === undefined) {
      throw new WorkspaceError(stage, 'workspace sem lease ativo neste provider', { detail: ws.id })
    }
    return state
  }

  async #acquire(lease: AttemptLease): Promise<Workspace> {
    const git = await isGitRepo(this.#root)
    const baseCommit = lease.baseCommit ?? (git ? await tryRevParse(this.#root, 'HEAD') : undefined)
    const branch = lease.branch ?? (git ? await currentBranch(this.#root) : undefined)
    const setup =
      this.#config.workspaceSetup === undefined
        ? EMPTY_SETUP_RESULT
        : await runWorkspaceSetup(
            this.#root,
            this.#repoRoot,
            this.#config.workspaceSetup,
            lease.signal,
            this.#config.setupProcessDeps,
          )
    const workspace: Workspace = {
      id: `shared/${lease.attemptId}`,
      kind: 'shared',
      path: this.#root,
      branch,
      baseCommit,
      leasedBy: lease.attemptId,
    }
    this.#leases.set(workspace.id, {
      workspace,
      scope: {
        touches: lease.touches ?? this.#config.touches ?? [],
        denyPaths: lease.denyPaths ?? this.#config.denyPaths ?? [],
      },
      links: setup.linked,
      setup,
      git,
    })
    return workspace
  }
}
