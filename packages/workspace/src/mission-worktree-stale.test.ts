import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { attemptId } from '@agentic/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestRepo, MISSION, RUN, type TestRepo } from './__fixtures__/repo.js'
import { WorkspaceError } from './errors.js'
import { GitWorktreeWorkspaceProvider } from './git-worktree-provider.js'
import { listWorktrees } from './repo.js'

/**
 * D3, o lado do disco. O gate da missao usa um caminho FIXO por run e o `finally` que o
 * libera nao roda quando o processo morre. Sem devolver essa worktree, adotar um run em
 * `VERIFYING` bateria em "caminho ja existe" e I12 transformaria isso em FAILED terminal.
 */

let repo: TestRepo | undefined

afterEach(async () => {
  await repo?.cleanup()
  repo = undefined
})

function providerOf(root: string): GitWorktreeWorkspaceProvider {
  return new GitWorktreeWorkspaceProvider({
    repoRoot: root,
    missionId: MISSION,
    worktreeRoot: '.agentic/worktrees',
    missionBranchPrefix: 'mission/',
    taskBranchPrefix: 'task/',
  })
}

const request = (
  attempt: string,
): Parameters<GitWorktreeWorkspaceProvider['acquireMissionWorkspace']>[0] => ({
  runId: RUN,
  attemptId: attemptId(attempt),
  missionId: MISSION,
})

function missionPath(root: string): string {
  return resolve(root, '.agentic/worktrees', RUN, 'mission')
}

describe('worktree do mission gate deixada por um reinicio', () => {
  it('e devolvida ao control plane: a proxima aquisicao funciona', async () => {
    repo = await createTestRepo()
    await providerOf(repo.root).ensureMissionBranch(MISSION)

    // Processo 1 adquire e MORRE: nenhum release roda, a worktree fica registrada.
    const primeiro = providerOf(repo.root)
    const antes = await primeiro.acquireMissionWorkspace(request('mission-gate-1'))
    expect(antes.path).toBe(missionPath(repo.root))
    expect((await listWorktrees(repo.root)).map((entry) => entry.path)).toContain(antes.path)

    // Processo 2: provider novo, mesmo caminho fixo.
    const depois = await providerOf(repo.root).acquireMissionWorkspace(request('mission-gate-2'))
    expect(depois.path).toBe(missionPath(repo.root))
    expect(depois.leasedBy).toBe(attemptId('mission-gate-2'))
    // Uma unica worktree naquele caminho: a antiga foi devolvida, nao empilhada.
    const esperado = missionPath(repo.root)
    const registradas = (await listWorktrees(repo.root)).filter((entry) => entry.path === esperado)
    expect(registradas).toHaveLength(1)
  })

  it('NAO remove diretorio que o git nao reconhece como worktree deste repositorio', async () => {
    repo = await createTestRepo()
    const path = missionPath(repo.root)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'coisa-de-alguem.txt'), 'nao me apague', 'utf8')

    await expect(
      providerOf(repo.root).acquireMissionWorkspace(request('mission-gate-1')),
    ).rejects.toBeInstanceOf(WorkspaceError)
    // A recusa e o comportamento certo: preferimos nao adquirir a destruir o que nao e nosso.
    expect(
      await repo.exists(join('.agentic/worktrees', RUN, 'mission', 'coisa-de-alguem.txt')),
    ).toBe(true)
  })

  it('NAO devolve worktree que o PROPRIO provider ainda tem em uso', async () => {
    repo = await createTestRepo()
    const provider = providerOf(repo.root)
    await provider.ensureMissionBranch(MISSION)
    // Mesmo provider, lease vivo: a segunda aquisicao e uso concorrente, nao rastro de
    // processo morto. Recusar e certo; devolver seria arrancar a arvore de quem a usa.
    await provider.acquireMissionWorkspace(request('mission-gate-1'))
    await expect(
      provider.acquireMissionWorkspace(request('mission-gate-2')),
    ).rejects.toBeInstanceOf(WorkspaceError)
    expect(await repo.exists(join('.agentic/worktrees', RUN, 'mission', 'README.md'))).toBe(true)
  })

  it('nunca alcanca a arvore principal do repositorio orquestrado', async () => {
    repo = await createTestRepo()
    await providerOf(repo.root).ensureMissionBranch(MISSION)
    await providerOf(repo.root).acquireMissionWorkspace(request('mission-gate-1'))
    await providerOf(repo.root).acquireMissionWorkspace(request('mission-gate-2'))

    const root = repo.root
    const principais = (await listWorktrees(root)).filter((entry) => entry.path === root)
    expect(principais).toHaveLength(1)
    expect(await repo.exists('README.md')).toBe(true)
  })
})
