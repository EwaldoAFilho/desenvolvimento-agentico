import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { attemptId } from '@agentic/domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * D2, o que acontece quando o `git worktree add` anexado e recusado.
 *
 * `worktreeOnBranch` responde pelo instante em que foi consultada: outra worktree pode
 * assumir a branch da missao entre a consulta e o `add`. O controle abaixo permite mentir
 * na PRIMEIRA consulta — reproduzindo a corrida — e tambem forcar uma recusa que NAO e
 * colisao de branch, para provar que ela sobe em vez de virar detached em silencio.
 */
const control = { lieOnFirstCheck: false, failAdd: undefined as Error | undefined }

vi.mock('./repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./repo.js')>()
  let lied = false
  return {
    ...actual,
    worktreeOnBranch: async (cwd: string, branch: string) => {
      if (control.lieOnFirstCheck && !lied) {
        lied = true
        return undefined
      }
      return actual.worktreeOnBranch(cwd, branch)
    },
    addWorktreeForBranch: async (cwd: string, path: string, branch: string, stage?: unknown) => {
      if (control.failAdd !== undefined) throw control.failAdd
      return actual.addWorktreeForBranch(
        cwd,
        path,
        branch,
        stage as Parameters<typeof actual.addWorktreeForBranch>[3],
      )
    },
  }
})

const { createTestRepo, MISSION, RUN } = await import('./__fixtures__/repo.js')
const { GitWorktreeWorkspaceProvider } = await import('./git-worktree-provider.js')

const exec = promisify(execFile)
let repo: Awaited<ReturnType<typeof createTestRepo>> | undefined

beforeEach(() => {
  control.lieOnFirstCheck = false
  control.failAdd = undefined
})

afterEach(async () => {
  await repo?.cleanup()
  repo = undefined
})

describe('mission worktree: recusa do add anexado', () => {
  it('branch tomada entre a consulta e o add: cai para detached sobre o sha', async () => {
    repo = await createTestRepo()
    const provider = new GitWorktreeWorkspaceProvider({ repoRoot: repo.root, missionId: MISSION })
    await provider.ensureMissionBranch()
    // A branch esta REALMENTE em check-out; so a primeira consulta diz o contrario.
    await repo.git('checkout', 'mission/DA-CORE-001')
    const missionSha = await repo.git('rev-parse', 'mission/DA-CORE-001')
    control.lieOnFirstCheck = true

    const ws = await provider.acquireMissionWorkspace({
      runId: RUN,
      attemptId: attemptId(`${RUN}:mission`),
    })

    expect(ws.branch).toBeUndefined()
    expect(ws.baseCommit).toBe(missionSha)
    const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: ws.path })
    expect(head.stdout.trim()).toBe(missionSha)
    expect(await repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('mission/DA-CORE-001')
  })

  it('falha que NAO e colisao de branch sobe, em vez de virar detached em silencio', async () => {
    repo = await createTestRepo()
    const provider = new GitWorktreeWorkspaceProvider({ repoRoot: repo.root, missionId: MISSION })
    await provider.ensureMissionBranch()
    // Branch livre: nenhuma worktree a segura. A recusa e por outro motivo qualquer.
    control.failAdd = new Error('disco cheio')

    await expect(
      provider.acquireMissionWorkspace({
        runId: RUN,
        attemptId: attemptId(`${RUN}:mission`),
      }),
    ).rejects.toThrow('disco cheio')
  })
})
