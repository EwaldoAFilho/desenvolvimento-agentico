import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { attemptId } from '@agentic/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestRepo, MISSION, RUN, type TestRepo } from './__fixtures__/repo.js'
import { WorkspaceError } from './errors.js'
import { GitWorktreeWorkspaceProvider } from './git-worktree-provider.js'
import {
  MISSION_OWNER_FILE,
  MISSION_OWNER_KIND,
  MISSION_OWNER_VERSION,
  type MissionOwnerMarker,
  missionOwnerPath,
} from './mission-owner.js'
import { listWorktrees } from './repo.js'

/**
 * D3, o lado do disco — e a prova de posse que o autoriza.
 *
 * O gate da missao usa um caminho FIXO por run e o `finally` que o libera nao roda quando o
 * processo morre. Devolver essa worktree e o que impede um run adotado em `VERIFYING` de
 * morrer por causa de um diretorio. Mas devolver e REMOVER: caminho, branch e SHA dizem de
 * onde a arvore veio, nunca quem a criou, e todos podem ser reproduzidos por terceiros.
 * Quem autoriza a remocao e o marcador que escrevemos ao criar — e so ele.
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

/** Deixa uma worktree do gate no disco como um processo que morreu deixaria. */
async function worktreeAbandonada(root: string): Promise<string> {
  const provider = providerOf(root)
  await provider.ensureMissionBranch(MISSION)
  const workspace = await provider.acquireMissionWorkspace(request('mission-gate-1'))
  return workspace.path
}

async function adulterar(path: string, patch: Partial<Record<string, unknown>>): Promise<void> {
  const atual = JSON.parse(await readFile(missionOwnerPath(path), 'utf8')) as Record<
    string,
    unknown
  >
  await writeFile(missionOwnerPath(path), JSON.stringify({ ...atual, ...patch }, null, 2), 'utf8')
}

const recusa = async (root: string): Promise<WorkspaceError> => {
  try {
    await providerOf(root).acquireMissionWorkspace(request('mission-gate-2'))
  } catch (error) {
    return error as WorkspaceError
  }
  throw new Error('a aquisicao deveria ter sido recusada')
}

describe('A — o marcador de posse nasce com a worktree do gate', () => {
  it('e escrito na raiz, com kind, versao, runId e repoRoot', async () => {
    repo = await createTestRepo()
    const path = await worktreeAbandonada(repo.root)

    const marker = JSON.parse(await readFile(missionOwnerPath(path), 'utf8')) as MissionOwnerMarker
    expect(marker.kind).toBe(MISSION_OWNER_KIND)
    expect(marker.version).toBe(MISSION_OWNER_VERSION)
    expect(marker.runId).toBe(RUN)
    expect(marker.repoRoot).toBe(repo.root)
    // Nada de segredo, token ou credencial: o marcador responde "de quem e isto", so isso.
    expect(Object.keys(marker).sort()).toEqual(['kind', 'repoRoot', 'runId', 'version'])
  })
})

describe('B — worktree deixada por um reinicio, com posse provada', () => {
  it('e devolvida ao control plane: a proxima aquisicao funciona', async () => {
    repo = await createTestRepo()
    const path = await worktreeAbandonada(repo.root)
    expect((await listWorktrees(repo.root)).map((entry) => entry.path)).toContain(path)

    // Processo 2: provider novo, mesmo caminho fixo, marcador intacto no disco.
    const depois = await providerOf(repo.root).acquireMissionWorkspace(request('mission-gate-2'))
    expect(depois.path).toBe(missionPath(repo.root))
    expect(depois.leasedBy).toBe(attemptId('mission-gate-2'))
    // Uma unica worktree naquele caminho: a antiga foi devolvida, nao empilhada.
    const esperado = missionPath(repo.root)
    const registradas = (await listWorktrees(repo.root)).filter((entry) => entry.path === esperado)
    expect(registradas).toHaveLength(1)
    // E a nova traz o proprio marcador: a prova nao se perde no caminho.
    expect(await readFile(missionOwnerPath(depois.path), 'utf8')).toContain(MISSION_OWNER_KIND)
  })
})

describe('C a G — sem prova de posse, nada e removido', () => {
  it('C — caminho, branch e SHA certos, mas sem marcador', async () => {
    repo = await createTestRepo()
    const path = await worktreeAbandonada(repo.root)
    await rm(missionOwnerPath(path), { force: true })

    const erro = await recusa(repo.root)
    expect(erro).toBeInstanceOf(WorkspaceError)
    expect(erro.detail).toContain(MISSION_OWNER_FILE)
    expect(await repo.exists(join('.agentic/worktrees', RUN, 'mission', 'README.md'))).toBe(true)
  })

  it('D — marcador de outro run', async () => {
    repo = await createTestRepo()
    const path = await worktreeAbandonada(repo.root)
    await adulterar(path, { runId: '01JBXQ7T9K4M2N8P6R3S5V7W9A' })

    const erro = await recusa(repo.root)
    expect(erro.detail).toContain('01JBXQ7T9K4M2N8P6R3S5V7W9A')
    expect(await repo.exists(join('.agentic/worktrees', RUN, 'mission', 'README.md'))).toBe(true)
  })

  it('E — marcador de outro repositorio', async () => {
    repo = await createTestRepo()
    const path = await worktreeAbandonada(repo.root)
    await adulterar(path, { repoRoot: '/algum/outro/repositorio' })

    const erro = await recusa(repo.root)
    expect(erro.detail).toContain('/algum/outro/repositorio')
    expect(await repo.exists(join('.agentic/worktrees', RUN, 'mission', 'README.md'))).toBe(true)
  })

  it('F — marcador malformado', async () => {
    repo = await createTestRepo()
    const path = await worktreeAbandonada(repo.root)
    await writeFile(missionOwnerPath(path), '{ isto nao e json', 'utf8')

    const erro = await recusa(repo.root)
    expect(erro.detail).toContain('ilegivel')
    expect(await repo.exists(join('.agentic/worktrees', RUN, 'mission', 'README.md'))).toBe(true)
  })

  it('F2 — marcador de outro tipo ou de versao futura', async () => {
    repo = await createTestRepo()
    const path = await worktreeAbandonada(repo.root)
    await adulterar(path, { kind: 'outra-coisa-qualquer' })
    expect((await recusa(repo.root)).detail).toContain('outra-coisa-qualquer')

    await adulterar(path, { kind: MISSION_OWNER_KIND, version: 99 })
    expect((await recusa(repo.root)).detail).toContain('99')
    expect(await repo.exists(join('.agentic/worktrees', RUN, 'mission', 'README.md'))).toBe(true)
  })

  it('G — worktree criada a mao por terceiro, na linha da branch da missao', async () => {
    // Este e o cenario que fechou o blocker: caminho reservado, repositorio certo, commit
    // na linha da missao, tudo o que a heuristica anterior exigia. E ainda assim nao e
    // nossa — ninguem escreveu o marcador — entao nao se toca nela.
    repo = await createTestRepo()
    const provider = providerOf(repo.root)
    const mission = await provider.ensureMissionBranch(MISSION)
    const path = missionPath(repo.root)
    await mkdir(join(repo.root, '.agentic/worktrees', RUN), { recursive: true })
    await repo.git('worktree', 'add', '--detach', path, mission.sha)
    await writeFile(join(path, 'trabalho-de-alguem.txt'), 'nao me apague', 'utf8')

    const erro = await recusa(repo.root)
    expect(erro.detail).toContain(MISSION_OWNER_FILE)
    expect(
      await repo.exists(join('.agentic/worktrees', RUN, 'mission', 'trabalho-de-alguem.txt')),
    ).toBe(true)
    const ainda = (await listWorktrees(repo.root)).find((entry) => entry.path === path)
    expect(ainda?.head).toBe(mission.sha)
  })
})

describe('as guardas anteriores continuam de pe', () => {
  it('nao toca diretorio que o git nao reconhece como worktree deste repositorio', async () => {
    repo = await createTestRepo()
    const path = missionPath(repo.root)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'coisa-de-alguem.txt'), 'nao me apague', 'utf8')

    const erro = await recusa(repo.root)
    expect(erro.detail).toContain('nao o reconhece')
    expect(
      await repo.exists(join('.agentic/worktrees', RUN, 'mission', 'coisa-de-alguem.txt')),
    ).toBe(true)
  })

  it('nao devolve worktree que o PROPRIO provider ainda tem em uso', async () => {
    repo = await createTestRepo()
    const provider = providerOf(repo.root)
    await provider.ensureMissionBranch(MISSION)
    await provider.acquireMissionWorkspace(request('mission-gate-1'))

    await expect(
      provider.acquireMissionWorkspace(request('mission-gate-2')),
    ).rejects.toBeInstanceOf(WorkspaceError)
    expect(await repo.exists(join('.agentic/worktrees', RUN, 'mission', 'README.md'))).toBe(true)
  })

  it('nunca alcanca a arvore principal do repositorio orquestrado', async () => {
    repo = await createTestRepo()
    await worktreeAbandonada(repo.root)
    await providerOf(repo.root).acquireMissionWorkspace(request('mission-gate-2'))

    const root = repo.root
    const principais = (await listWorktrees(root)).filter((entry) => entry.path === root)
    expect(principais).toHaveLength(1)
    expect(await repo.exists('README.md')).toBe(true)
  })

  it('recusa caminho que escaparia do worktreeRoot', async () => {
    repo = await createTestRepo()
    await expect(
      providerOf(repo.root).acquireMissionWorkspace({
        runId: '../../fora' as never,
        attemptId: attemptId('mission-gate-1'),
        missionId: MISSION,
      }),
    ).rejects.toThrow(/fora do worktreeRoot/)
  })
})
