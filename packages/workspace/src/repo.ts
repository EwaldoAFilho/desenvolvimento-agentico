import { realpath, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CommitRef } from '@agentic/domain'
import { WorkspaceError, type WorkspaceStage } from './errors.js'
import { git, gitText } from './git.js'

export interface WorktreeEntry {
  readonly path: string
  readonly head?: string
  readonly branch?: string
  readonly bare: boolean
  readonly detached: boolean
}

/** `git worktree list --porcelain`: registros separados por linha em branco. */
export function parseWorktreeList(raw: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: { path?: string; head?: string; branch?: string; bare: boolean; detached: boolean } =
    { bare: false, detached: false }
  const flush = (): void => {
    if (current.path !== undefined) {
      entries.push({
        path: current.path,
        head: current.head,
        branch: current.branch,
        bare: current.bare,
        detached: current.detached,
      })
    }
    current = { bare: false, detached: false }
  }
  for (const line of raw.split('\n')) {
    const text = line.trimEnd()
    if (text.length === 0) {
      flush()
      continue
    }
    if (text.startsWith('worktree ')) {
      flush()
      current.path = text.slice('worktree '.length)
    } else if (text.startsWith('HEAD ')) current.head = text.slice('HEAD '.length)
    else if (text.startsWith('branch ')) {
      current.branch = text.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (text === 'bare') current.bare = true
    else if (text === 'detached') current.detached = true
  }
  flush()
  return entries
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await git(['rev-parse', '--is-inside-work-tree'], { cwd, allowFailure: true })
  return result.exitCode === 0 && result.stdout.trim() === 'true'
}

export async function revParse(cwd: string, rev: string, stage?: WorkspaceStage): Promise<string> {
  return gitText(['rev-parse', '--verify', `${rev}^{commit}`], { cwd, stage })
}

export async function tryRevParse(cwd: string, rev: string): Promise<string | undefined> {
  const result = await git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
    cwd,
    allowFailure: true,
  })
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const result = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd,
    allowFailure: true,
  })
  return result.exitCode === 0
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const result = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd,
    allowFailure: true,
  })
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const raw = await gitText(['worktree', 'list', '--porcelain'], { cwd })
  return parseWorktreeList(raw)
}

export async function worktreeOnBranch(
  cwd: string,
  branch: string,
): Promise<WorktreeEntry | undefined> {
  const entries = await listWorktrees(cwd)
  return entries.find((entry) => entry.branch === branch)
}

/**
 * A worktree que ESTE repositorio registra naquele caminho, se houver.
 *
 * A comparacao passa por `realpath` dos dois lados: o git responde o caminho ja resolvido,
 * e um `worktreeRoot` sob link simbolico (o `/tmp` da suite, por exemplo) daria uma
 * diferenca puramente textual. Nao encontrar aqui e a resposta que autoriza NAO remover
 * nada: diretorio que este repositorio nao reconhece como worktree sua nao e nosso.
 */
export async function worktreeAtPath(
  cwd: string,
  path: string,
): Promise<WorktreeEntry | undefined> {
  const wanted = await realpath(path).catch(() => resolve(path))
  const entries = await listWorktrees(cwd)
  for (const entry of entries) {
    const candidate = await realpath(entry.path).catch(() => resolve(entry.path))
    if (candidate === wanted) return entry
  }
  return undefined
}

/** Cria a branch da missao se ainda nao existir; idempotente por natureza. */
export async function ensureBranch(
  cwd: string,
  branch: string,
  base: string,
  stage: WorkspaceStage = 'acquire',
): Promise<CommitRef> {
  if (!(await branchExists(cwd, branch))) {
    const baseSha = await tryRevParse(cwd, base)
    if (baseSha === undefined) {
      throw new WorkspaceError(stage, `base inexistente para a branch ${branch}`, { detail: base })
    }
    await git(['branch', branch, baseSha], { cwd, stage })
  }
  const sha = await revParse(cwd, branch, stage)
  return { sha, branch }
}

export async function addWorktree(
  cwd: string,
  path: string,
  branch: string,
  startPoint: string,
  stage: WorkspaceStage = 'acquire',
): Promise<void> {
  await git(['worktree', 'add', '-b', branch, path, startPoint], { cwd, stage })
}

export async function addWorktreeForBranch(
  cwd: string,
  path: string,
  branch: string,
  stage: WorkspaceStage = 'integrate',
): Promise<void> {
  await git(['worktree', 'add', path, branch], { cwd, stage })
}

/**
 * Worktree presa a um COMMIT, sem anexar branch. O git recusa duas worktrees na mesma
 * branch; quando so precisamos LER a arvore de um commit — o caso do mission gate — o
 * detach evita a colisao sem forcar nada nem mexer em quem ja segura a branch.
 */
export async function addWorktreeDetached(
  cwd: string,
  path: string,
  commit: string,
  stage: WorkspaceStage = 'acquire',
): Promise<void> {
  await git(['worktree', 'add', '--detach', path, commit], { cwd, stage })
}

/** Remocao tolerante: o disco precisa ficar limpo mesmo se o registro do git ja divergiu. */
export async function removeWorktree(cwd: string, path: string): Promise<void> {
  const result = await git(['worktree', 'remove', '--force', path], { cwd, allowFailure: true })
  if (result.exitCode !== 0) await rm(path, { recursive: true, force: true })
  await git(['worktree', 'prune'], { cwd, allowFailure: true })
}

/**
 * Fast-forward sem checkout: se ninguem tem a branch aberta, mover o ref com CAS e mais
 * seguro do que trocar a arvore principal de branch.
 */
export async function fastForwardBranch(
  cwd: string,
  branch: string,
  target: string,
  expected: string,
): Promise<void> {
  const holder = await worktreeOnBranch(cwd, branch)
  if (holder !== undefined) {
    await git(['-C', holder.path, 'merge', '--ff-only', target], { cwd, stage: 'integrate' })
    return
  }
  await git(['update-ref', '-m', 'agentic integrate', `refs/heads/${branch}`, target, expected], {
    cwd,
    stage: 'integrate',
  })
}

export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await git(['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    allowFailure: true,
  })
  return result.exitCode === 0
}

export async function unmergedPaths(cwd: string): Promise<string[]> {
  const result = await git(['diff', '--name-only', '--diff-filter=U', '-z'], {
    cwd,
    allowFailure: true,
  })
  return result.stdout.split('\0').filter((token) => token.length > 0)
}
