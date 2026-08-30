import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AgentProfileId,
  Attempt,
  AttemptId,
  ProviderId,
  TaskId,
  Workspace,
} from '@agentic/domain'
import { taskId, taskRunId } from '@agentic/domain'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createTestRepo,
  lease,
  MISSION,
  RUN,
  T01,
  T02,
  type TestRepo,
} from './__fixtures__/repo.js'
import { GitWorktreeWorkspaceProvider } from './git-worktree-provider.js'
import { GitIntegrator } from './integrator.js'
import { currentBranch } from './repo.js'

let repo: TestRepo | undefined

afterEach(async () => {
  await repo?.cleanup()
  repo = undefined
})

/** Attempt e append-only e enorme; o Integrator so olha branch, path e numero. */
function attemptOf(ws: Workspace, task: TaskId, attemptNumber = 1): Attempt {
  return {
    id: ws.leasedBy,
    taskRunId: taskRunId(RUN, task),
    attemptNumber,
    executor: {
      profileId: 'executor' as AgentProfileId,
      providerId: 'mock' as ProviderId,
      sessionRef: 'sessao-1',
      startedAt: new Date(0),
    },
    dispatchReason: {
      dependenciesSatisfied: [],
      locksAcquired: [],
      providerId: 'mock' as ProviderId,
      slot: 'executor',
      priority: 0,
    },
    workspace: {
      kind: ws.kind,
      path: ws.path,
      branch: ws.branch,
      baseCommit: ws.baseCommit,
    },
    startedAt: new Date(0),
    gateExecutions: [],
  }
}

const write = (base: string, relative: string, content: string): Promise<void> =>
  mkdir(join(base, relative, '..'), { recursive: true }).then(() =>
    writeFile(join(base, relative), content, 'utf8'),
  )

interface Bancada {
  readonly provider: GitWorktreeWorkspaceProvider
  readonly integrator: GitIntegrator
}

function bancada(root: string): Bancada {
  return {
    provider: new GitWorktreeWorkspaceProvider({ repoRoot: root, missionId: MISSION }),
    integrator: new GitIntegrator({ repoRoot: root, missionId: MISSION }),
  }
}

describe('GitIntegrator.ensureMissionBranch', () => {
  it('cria a branch da missao a partir da base informada', async () => {
    repo = await createTestRepo()
    const { integrator } = bancada(repo.root)
    const ref = await integrator.ensureMissionBranch(MISSION, 'main')
    expect(ref.branch).toBe('mission/DA-CORE-001')
    expect(ref.sha).toBe(await repo.git('rev-parse', 'main'))
  })

  it('e idempotente: chamar de novo nao move a branch', async () => {
    repo = await createTestRepo()
    const { integrator } = bancada(repo.root)
    const primeira = await integrator.ensureMissionBranch()
    await repo.write('README.md', 'mudou\n')
    await repo.commitAll('avanca main')
    const segunda = await integrator.ensureMissionBranch()
    expect(segunda.sha).toBe(primeira.sha)
  })
})

describe('integracao feliz', () => {
  it('duas tasks com arquivos disjuntos integram em sequencia na branch da missao', async () => {
    repo = await createTestRepo()
    const { provider, integrator } = bancada(repo.root)
    const a = await provider.acquire(lease({ task: 'T01', touches: ['packages/a/'] }))
    const b = await provider.acquire(lease({ task: 'T02', touches: ['packages/b/'] }))
    await write(a.path, 'packages/a/a.ts', 'export const a = 2\n')
    await write(b.path, 'packages/b/b.ts', 'export const b = 2\n')
    await provider.commit(a, 'T01: altera a')
    await provider.commit(b, 'T02: altera b')

    const first = await integrator.integrate(attemptOf(a, T01))
    const second = await integrator.integrate(attemptOf(b, T02))

    expect(first.status).toBe('MERGED')
    expect(second.status).toBe('MERGED')
    expect(second.commit?.branch).toBe('mission/DA-CORE-001')
    const arquivoA = await repo.git('show', 'mission/DA-CORE-001:packages/a/a.ts')
    const arquivoB = await repo.git('show', 'mission/DA-CORE-001:packages/b/b.ts')
    expect(arquivoA).toBe('export const a = 2')
    expect(arquivoB).toBe('export const b = 2')
  })

  it('nada a integrar vira SKIPPED', async () => {
    repo = await createTestRepo()
    const { provider, integrator } = bancada(repo.root)
    const ws = await provider.acquire(lease({ task: 'T01' }))
    const result = await integrator.integrate(attemptOf(ws, T01))
    expect(result.status).toBe('SKIPPED')
  })

  it('integra mesmo com a worktree da tentativa ja descartada', async () => {
    repo = await createTestRepo()
    const { provider, integrator } = bancada(repo.root)
    const ws = await provider.acquire(lease({ task: 'T01' }))
    await write(ws.path, 'packages/a/a.ts', 'export const a = 3\n')
    await provider.commit(ws, 'T01: altera a')
    await provider.release(ws, 'discard')

    const result = await integrator.integrate(attemptOf(ws, T01))

    expect(result.status).toBe('MERGED')
    expect(await repo.git('show', 'mission/DA-CORE-001:packages/a/a.ts')).toBe('export const a = 3')
    const temporaria = join(repo.root, '.agentic/worktrees/.integration')
    const entradas = await stat(join(temporaria, 'task-DA-CORE-001-T01-a1')).catch(() => null)
    expect(entradas).toBeNull()
  })
})

describe('conflito de integracao', () => {
  it('duas tentativas na mesma linha: a segunda devolve CONFLICT e a missao fica limpa', async () => {
    repo = await createTestRepo()
    const { provider, integrator } = bancada(repo.root)
    const a = await provider.acquire(lease({ task: 'T01', touches: ['packages/a/'] }))
    const b = await provider.acquire(lease({ task: 'T02', touches: ['packages/a/'] }))
    await write(a.path, 'packages/a/a.ts', 'export const a = 100\n')
    await write(b.path, 'packages/a/a.ts', 'export const a = 200\n')
    await provider.commit(a, 'T01: a = 100')
    await provider.commit(b, 'T02: a = 200')

    const first = await integrator.integrate(attemptOf(a, T01))
    const second = await integrator.integrate(attemptOf(b, T02))

    expect(first.status).toBe('MERGED')
    expect(second.status).toBe('CONFLICT')
    expect(second.conflicts).toEqual(['packages/a/a.ts'])
  })

  it('conflito aborta o rebase: worktree e branch da missao ficam limpas', async () => {
    repo = await createTestRepo()
    const { provider, integrator } = bancada(repo.root)
    const a = await provider.acquire(lease({ task: 'T01', touches: ['packages/a/'] }))
    const b = await provider.acquire(lease({ task: 'T02', touches: ['packages/a/'] }))
    await write(a.path, 'packages/a/a.ts', 'export const a = 100\n')
    await write(b.path, 'packages/a/a.ts', 'export const a = 200\n')
    await provider.commit(a, 'T01: a = 100')
    await provider.commit(b, 'T02: a = 200')
    await integrator.integrate(attemptOf(a, T01))
    const missaoAntes = await repo.git('rev-parse', 'mission/DA-CORE-001')

    const result = await integrator.integrate(attemptOf(b, T02))

    expect(result.status).toBe('CONFLICT')
    expect(await repo.git('rev-parse', 'mission/DA-CORE-001')).toBe(missaoAntes)
    expect(await repo.git('status', '--porcelain')).toBe('')
    expect(await repo.git('-C', b.path, 'status', '--porcelain')).toBe('')
    expect(await currentBranch(b.path)).toBe('task/DA-CORE-001/T02/a1')
    expect(await stat(join(repo.root, '.git', 'worktrees')).catch(() => null)).not.toBeNull()
  })

  it('a tentativa seguinte parte da base ja atualizada e integra', async () => {
    repo = await createTestRepo()
    const { provider, integrator } = bancada(repo.root)
    const a = await provider.acquire(lease({ task: 'T01', touches: ['packages/a/'] }))
    const b = await provider.acquire(lease({ task: 'T02', touches: ['packages/a/'] }))
    await write(a.path, 'packages/a/a.ts', 'export const a = 100\n')
    await write(b.path, 'packages/a/a.ts', 'export const a = 200\n')
    await provider.commit(a, 'T01: a = 100')
    await provider.commit(b, 'T02: a = 200')
    await integrator.integrate(attemptOf(a, T01))
    expect((await integrator.integrate(attemptOf(b, T02))).status).toBe('CONFLICT')
    await provider.release(b, 'discard')

    const retry = await provider.acquire(
      lease({ task: 'T02', attempt: 2, touches: ['packages/a/'] }),
    )
    await write(retry.path, 'packages/a/a.ts', 'export const a = 300\n')
    await provider.commit(retry, 'T02: a = 300')
    const result = await integrator.integrate(attemptOf(retry, T02, 2))

    expect(result.status).toBe('MERGED')
    expect(await repo.git('show', 'mission/DA-CORE-001:packages/a/a.ts')).toBe(
      'export const a = 300',
    )
  })

  it('branch de tentativa inexistente e erro de workspace, nao conflito', async () => {
    repo = await createTestRepo()
    const { integrator } = bancada(repo.root)
    const fantasma: Workspace = {
      id: 'x',
      kind: 'git-worktree',
      path: join(repo.root, 'nao-existe'),
      branch: 'task/DA-CORE-001/T09/a1',
      baseCommit: await repo.git('rev-parse', 'HEAD'),
      leasedBy: 'a1' as AttemptId,
    }
    await expect(integrator.integrate(attemptOf(fantasma, taskId('T09')))).rejects.toThrow(/branch/)
  })
})
