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

  it('NAO devolve worktree registrada que nao seja a do gate da missao', async () => {
    repo = await createTestRepo()
    const path = missionPath(repo.root)
    // Worktree legitima do git deste repositorio, mas de OUTRA branch, ocupando o slot.
    // Registro no repo certo nao e prova de procedencia: `#acquireMission` so cria
    // anexada a branch da missao ou detached sobre o commit dela.
    await repo.git('branch', 'alguma-outra-coisa')
    await repo.git('worktree', 'add', path, 'alguma-outra-coisa')

    await expect(
      providerOf(repo.root).acquireMissionWorkspace(request('mission-gate-1')),
    ).rejects.toBeInstanceOf(WorkspaceError)
    const esperado = missionPath(repo.root)
    const ainda = (await listWorktrees(repo.root)).find((entry) => entry.path === esperado)
    expect(ainda?.branch).toBe('alguma-outra-coisa')
  })

  it('NAO devolve worktree detached que nao esta na linha da missao', async () => {
    repo = await createTestRepo()
    const path = missionPath(repo.root)
    // Detached sozinho nao prova procedencia: uma arvore solta em SHA arbitrario tambem e
    // detached. Aqui o commit vive numa linha propria, sem relacao com a branch da missao.
    await providerOf(repo.root).ensureMissionBranch(MISSION)
    await repo.git('checkout', '-q', '-b', 'linha-paralela')
    await repo.write('so-daqui.txt', 'commit fora da linha da missao')
    await repo.commitAll('commit paralelo')
    const forasteiro = await repo.git('rev-parse', 'HEAD')
    await repo.git('checkout', '-q', 'main')
    await repo.git('worktree', 'add', '--detach', path, forasteiro)

    await expect(
      providerOf(repo.root).acquireMissionWorkspace(request('mission-gate-1')),
    ).rejects.toBeInstanceOf(WorkspaceError)
    const ainda = (await listWorktrees(repo.root)).find((entry) => entry.path === path)
    expect(ainda?.head).toBe(forasteiro)
  })

  it('devolve worktree detached cujo commit ESTA na linha da missao', async () => {
    repo = await createTestRepo()
    const provider = providerOf(repo.root)
    const mission = await provider.ensureMissionBranch(MISSION)
    const path = missionPath(repo.root)
    // E assim que `#acquireMission` cria quando a branch ja esta em check-out: detached
    // sobre o commit da missao. Um reinicio deixa exatamente isto para tras.
    await repo.git('worktree', 'add', '--detach', path, mission.sha)

    const workspace = await providerOf(repo.root).acquireMissionWorkspace(request('mission-gate-2'))
    expect(workspace.path).toBe(path)
    expect(workspace.leasedBy).toBe(attemptId('mission-gate-2'))
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
