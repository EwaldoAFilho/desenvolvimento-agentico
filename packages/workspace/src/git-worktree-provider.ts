import { mkdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
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
import { proveMissionOwnership, writeMissionOwner } from './mission-owner.js'
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
import {
  addWorktree,
  addWorktreeDetached,
  addWorktreeForBranch,
  ensureBranch,
  isAncestor,
  removeWorktree,
  removeWorktreeStrict,
  revParse,
  worktreeAtPath,
  worktreeOnBranch,
} from './repo.js'
import {
  EMPTY_SETUP_RESULT,
  runWorkspaceSetup,
  type SetupProcessDeps,
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
  /** Sonda e teto do grupo de processos dos comandos de `workspaceSetup` (injetavel no teste). */
  readonly setupProcessDeps?: SetupProcessDeps
  readonly denyPaths?: readonly PathScope[]
  /** Escopo usado quando o lease nao declara `touches`. */
  readonly touches?: readonly PathScope[]
}

export interface MissionWorkspaceRequest {
  readonly runId: RunId
  readonly attemptId: AttemptId
  readonly missionId?: MissionId
  /** Cancelamento cooperativo do `workspaceSetup` (encerramento do control plane). */
  readonly signal?: AbortSignal
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
    const setup = await this.#setupOrCleanup(path, lease.signal)
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
    // O `runId` chega como texto. Um id com `..` faria o caminho escapar do territorio do
    // Agentic, e a devolucao — que e uma REMOCAO — passaria a alcancar arvore de terceiro.
    // A checagem e barata e fecha isso antes de qualquer efeito.
    this.#assertInsideWorktreeRoot(path)
    const recusa = await this.#reclaimMissionWorktree(id, path, branch, mission.sha, request.runId)
    // O caminho continuar ocupado sem que a posse tenha sido provada nao e um detalhe: e a
    // unica coisa que o humano precisa saber para destravar o run.
    await this.#assertFreePath(path, recusa)
    await mkdir(dirname(path), { recursive: true })
    // O mission gate valida a ENTREGA INTEGRADA, que e um COMMIT — nao precisa da branch
    // anexada. Quando alguem ja a tem em check-out (o proprio repositorio orquestrado, no
    // dogfooding), `git worktree add <path> <branch>` falha com exit 128; ai vamos de
    // detach sobre o MESMO sha: mesma arvore, sem disputar o ref. Com a branch livre, nada
    // muda — o gate continua rodando com HEAD nela.
    let attached = (await worktreeOnBranch(this.#repoRoot, branch)) === undefined
    if (attached) {
      try {
        await addWorktreeForBranch(this.#repoRoot, path, branch, 'acquire')
      } catch (error) {
        // Distingue colisao de branch de QUALQUER outra falha sem depender do texto do
        // git: se agora alguem segura a branch, era a corrida; senao o erro e outro (disco,
        // permissao, caminho ocupado) e sobe inalterado — cair para detached ali mascararia
        // defeito, e apagar o caminho poderia destruir a worktree de outro processo.
        if ((await worktreeOnBranch(this.#repoRoot, branch)) === undefined) throw error
        attached = false
        await addWorktreeDetached(this.#repoRoot, path, mission.sha, 'acquire')
      }
    } else {
      await addWorktreeDetached(this.#repoRoot, path, mission.sha, 'acquire')
    }
    // A PROVA DE POSSE vem logo apos o `add`, antes de qualquer outro trabalho: e o que
    // permite devolver esta arvore depois de uma queda. Escreve-la mais tarde alargaria a
    // janela em que um crash deixa para tras uma worktree que nao conseguimos reivindicar.
    await writeMissionOwner(path, { runId: request.runId, repoRoot: this.#repoRoot })
    // MEDIDO na arvore criada, nunca presumido do ref: entre ler o sha e criar a worktree
    // a branch pode ter andado, e `baseCommit` precisa ser o commit que o gate de fato viu.
    const baseCommit = await revParse(path, 'HEAD', 'acquire')
    const workspace: Workspace = {
      id,
      kind: 'git-worktree',
      path,
      // Detached: HEAD nao esta em branch nenhuma e dizer que esta seria mentir sobre a
      // arvore. O `baseCommit` continua sendo o fato que o gate julga.
      ...(attached ? { branch } : {}),
      baseCommit,
      leasedBy: request.attemptId,
    }
    const setup = await this.#setupOrCleanup(path, request.signal)
    this.#leases.set(id, {
      workspace,
      scope: { touches: [], denyPaths: this.#config.denyPaths ?? [] },
      links: setup.linked,
      setup,
    })
    return workspace
  }

  /** O caminho da worktree tem de cair DENTRO do territorio do Agentic, sempre. */
  #assertInsideWorktreeRoot(path: string): void {
    const root = resolve(this.#worktreeRoot)
    const alvo = resolve(path)
    if (alvo !== root && !alvo.startsWith(`${root}${sep}`)) {
      throw new WorkspaceError('acquire', 'caminho de worktree fora do worktreeRoot', {
        detail: alvo,
      })
    }
  }

  /**
   * Devolve ao control plane a worktree do gate da missao que um reinicio deixou para tras.
   *
   * O caminho e fixo por run (`<worktreeRoot>/<runId>/mission`), e o `finally` que a
   * liberaria nao roda quando o processo morre. Sem isto, adotar um run em `VERIFYING`
   * bateria em `#assertFreePath` e — com I12 convertendo a falha em desfecho de gate — o
   * run iria a FAILED por causa de um diretorio, nao de uma reprovacao.
   *
   * Devolver e REMOVER, entao a barra e prova, nao indicio. Caminho, branch, SHA e
   * ancestralidade continuam sendo verificados, mas nenhum deles diz quem criou a arvore —
   * todos podem ser reproduzidos por quem quiser. Quem decide e o marcador de posse que
   * `#acquireMission` escreve: sem ele, ou com ele apontando para outro run ou outro
   * repositorio, nada e removido e a recusa sobe com o motivo.
   *
   * Devolve `undefined` quando nao havia o que devolver ou a devolucao funcionou; devolve
   * o motivo quando encontrou algo ali e decidiu NAO tocar.
   */
  async #reclaimMissionWorktree(
    id: string,
    path: string,
    branch: string,
    missionSha: string,
    runId: string,
  ): Promise<string | undefined> {
    // Lease vivo NESTE provider significa que a worktree esta em uso agora, aqui — nao e
    // rastro de processo morto. Devolve-la seria arrancar o chao de quem esta usando; a
    // recusa de `#assertFreePath` e a resposta certa para uso concorrente.
    if (this.#leases.has(id)) return 'a worktree esta em uso por este control plane agora'
    const existing = await stat(path).catch(() => null)
    if (existing === null) return undefined
    // Nao basta existir um diretorio ali: o git DESTE repositorio precisa reconhece-lo
    // como worktree sua. O que ele nao reconhece nao e nosso e nao e tocado.
    const registered = await worktreeAtPath(this.#repoRoot, path)
    if (registered === undefined) {
      return 'o caminho existe mas o git deste repositorio nao o reconhece como worktree sua'
    }
    // A arvore principal nunca esta sob `worktreeRoot`; recusar explicitamente e barato e
    // fecha a unica forma de esta remocao alcancar o repositorio orquestrado.
    const main = await worktreeAtPath(this.#repoRoot, this.#repoRoot)
    if (main !== undefined && main.path === registered.path) {
      return 'o caminho aponta para a arvore principal do repositorio'
    }
    // PROVA DE POSSE. E o unico sinal que um terceiro nao consegue produzir sem querer:
    // ele existe porque NOS o escrevemos, naquela arvore, para aquele run.
    const posse = await proveMissionOwnership(path, { runId, repoRoot: this.#repoRoot })
    if (!posse.ok) return posse.reason
    // Confirmacoes adicionais, agora que a posse esta provada: a arvore do gate nasce
    // anexada a branch da missao ou detached sobre um commit da linha dela. Um marcador
    // valido sobre uma arvore que nao e nenhuma das duas e incoerente — e diante de
    // incoerencia a resposta continua sendo nao remover.
    const daBranch = registered.branch === branch
    const daLinha =
      registered.detached &&
      registered.head !== undefined &&
      (await isAncestor(this.#repoRoot, registered.head, missionSha))
    if (!daBranch && !daLinha) {
      return 'a worktree tem marcador de posse mas nao esta na branch nem na linha da missao'
    }
    // Sem `rm -rf` de consolo: se o git recusar devolver, preferimos recusar a aquisicao a
    // apagar por conta propria algo que ele nao quis soltar.
    const removida = await removeWorktreeStrict(this.#repoRoot, path)
    return removida ? undefined : 'o git recusou devolver a worktree'
  }

  async #assertFreePath(path: string, reason?: string): Promise<void> {
    const existing = await stat(path).catch(() => null)
    if (existing !== null) {
      const detail = reason === undefined ? path : `${path}: ${reason}`
      throw new WorkspaceError('acquire', 'caminho de worktree ja existe', { detail })
    }
  }

  /**
   * Worktree sem setup e worktree inutil: se o setup falhar, ela sai do disco para que a
   * proxima tentativa possa recriar, e o erro sobe como WORKSPACE_ERROR.
   */
  async #setupOrCleanup(path: string, signal?: AbortSignal): Promise<WorkspaceSetupResult> {
    if (this.#config.workspaceSetup === undefined) return EMPTY_SETUP_RESULT
    try {
      return await runWorkspaceSetup(
        path,
        this.#repoRoot,
        this.#config.workspaceSetup,
        signal,
        this.#config.setupProcessDeps,
      )
    } catch (error) {
      await removeWorktree(this.#repoRoot, path).catch(() => undefined)
      throw error
    }
  }
}
