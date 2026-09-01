import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { attemptId } from '@agentic/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestRepo, lease, MISSION, RUN, type TestRepo } from './__fixtures__/repo.js'
import { isWorkspaceError, type WorkspaceError } from './errors.js'
import { GitWorktreeWorkspaceProvider } from './git-worktree-provider.js'
import { isNoChanges } from './ops.js'
import { listWorktrees } from './repo.js'

const exec = promisify(execFile)

let repo: TestRepo | undefined

afterEach(async () => {
  await repo?.cleanup()
  repo = undefined
})

const providerFor = (root: string, extra = {}): GitWorktreeWorkspaceProvider =>
  new GitWorktreeWorkspaceProvider({ repoRoot: root, missionId: MISSION, ...extra })

const write = (base: string, relative: string, content: string): Promise<void> =>
  mkdir(join(base, relative, '..'), { recursive: true }).then(() =>
    writeFile(join(base, relative), content, 'utf8'),
  )

describe('GitWorktreeWorkspaceProvider.acquire', () => {
  it('cria a branch da missao quando ela nao existe', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const ref = await provider.ensureMissionBranch()
    expect(ref.branch).toBe('mission/DA-CORE-001')
    expect(await repo.git('rev-parse', 'mission/DA-CORE-001')).toBe(ref.sha)
  })

  it('cria uma worktree por tentativa no caminho e branch previstos', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const ws = await provider.acquire(lease({ task: 'T08', attempt: 2 }))

    expect(ws.kind).toBe('git-worktree')
    expect(ws.path).toBe(join(repo.root, '.agentic/worktrees', RUN, 'T08-a2'))
    expect(ws.branch).toBe('task/DA-CORE-001/T08/a2')
    expect(ws.baseCommit).toBe(await repo.git('rev-parse', 'mission/DA-CORE-001'))
    expect((await stat(ws.path)).isDirectory()).toBe(true)
    const entries = await listWorktrees(repo.root)
    expect(entries.some((entry) => entry.branch === 'task/DA-CORE-001/T08/a2')).toBe(true)
  })

  it('recusa lease de outro kind', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    await expect(provider.acquire({ ...lease(), kind: 'shared' })).rejects.toThrow(/neste provider/)
  })

  it('recusa reaproveitar caminho de worktree ja existente', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    await provider.acquire(lease())
    await expect(provider.acquire(lease())).rejects.toThrow(/ja existe/)
  })
})

describe('isolamento entre tentativas', () => {
  it('duas worktrees simultaneas nao interferem: cada diff enxerga so o seu', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const a = await provider.acquire(lease({ task: 'T01', touches: ['packages/a/'] }))
    const b = await provider.acquire(lease({ task: 'T02', touches: ['packages/b/'] }))

    await write(a.path, 'packages/a/a.ts', 'export const a = 2\n')
    await write(b.path, 'packages/b/b.ts', 'export const b = 2\n')

    const diffA = await provider.diff(a)
    const diffB = await provider.diff(b)

    expect(diffA.filesChanged.map((c) => c.path)).toEqual(['packages/a/a.ts'])
    expect(diffB.filesChanged.map((c) => c.path)).toEqual(['packages/b/b.ts'])
    expect(diffA.scopeCheck).toBe('PASS')
    expect(diffB.scopeCheck).toBe('PASS')
    expect(await readFile(join(a.path, 'packages/b/b.ts'), 'utf8')).toBe('export const b = 1\n')
    expect(await readFile(join(b.path, 'packages/a/a.ts'), 'utf8')).toBe('export const a = 1\n')
  })

  it('commit de uma tentativa nao aparece na outra', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const a = await provider.acquire(lease({ task: 'T01', touches: ['packages/a/'] }))
    const b = await provider.acquire(lease({ task: 'T02', touches: ['packages/b/'] }))
    await write(a.path, 'packages/a/a.ts', 'export const a = 2\n')
    await provider.commit(a, 'T01: altera a')

    const diffB = await provider.diff(b)
    expect(diffB.filesChanged).toEqual([])
    expect(diffB.diffStat).toEqual({ files: 0, added: 0, removed: 0 })
  })
})

describe('workspaceSetup', () => {
  it('deixa a worktree apta a rodar um comando que depende do link', async () => {
    repo = await createTestRepo()
    await mkdir(join(repo.root, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(repo.root, 'node_modules', 'dep', 'index.js'), 'module.exports = 7\n')
    const provider = providerFor(repo.root, {
      workspaceSetup: {
        link: ['node_modules'],
        commands: ['node -e "process.exit(require(\'./node_modules/dep\') === 7 ? 0 : 1)"'],
      },
    })

    const ws = await provider.acquire(lease())

    expect(provider.setupOf(ws)?.linked).toEqual(['node_modules'])
    const { stdout } = await exec('node', ['-p', "require('./node_modules/dep')"], { cwd: ws.path })
    expect(stdout.trim()).toBe('7')
  })

  it('sem workspaceSetup o mesmo comando falharia na worktree nova', async () => {
    repo = await createTestRepo()
    await mkdir(join(repo.root, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(repo.root, 'node_modules', 'dep', 'index.js'), 'module.exports = 7\n')
    const provider = providerFor(repo.root)
    const ws = await provider.acquire(lease())
    await expect(
      exec('node', ['-p', "require('./node_modules/dep')"], { cwd: ws.path }),
    ).rejects.toThrow()
  })

  it('o link nao entra na observacao do diff', async () => {
    repo = await createTestRepo()
    // Sem .gitignore o link viraria ruido no diff: a exclusao tem de vir do proprio setup.
    await rm(join(repo.root, '.gitignore'))
    await repo.commitAll('sem gitignore')
    await mkdir(join(repo.root, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(repo.root, 'node_modules', 'dep', 'index.js'), 'module.exports = 7\n')
    const provider = providerFor(repo.root, { workspaceSetup: { link: ['node_modules'] } })
    const ws = await provider.acquire(lease())
    await write(ws.path, 'packages/a/a.ts', 'export const a = 2\n')

    const observation = await provider.diff(ws)
    expect(observation.filesChanged.map((c) => c.path)).toEqual(['packages/a/a.ts'])
  })

  it('falha de setup vira WORKSPACE_ERROR, nunca falha de gate, e limpa a worktree', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root, {
      workspaceSetup: { commands: [{ run: 'exit 3' }] },
    })
    const alvo = join(repo.root, '.agentic/worktrees', RUN, 'T01-a1')

    const erro = await provider.acquire(lease()).catch((error: unknown) => error)

    expect(isWorkspaceError(erro)).toBe(true)
    const workspaceError = erro as WorkspaceError
    expect(workspaceError.stage).toBe('setup')
    expect(workspaceError.toFailureReason().code).toBe('WORKSPACE_ERROR')
    expect(await stat(alvo).catch(() => null)).toBeNull()
    const entries = await listWorktrees(repo.root)
    expect(entries.some((entry) => entry.path === alvo)).toBe(false)
  })
})

describe('diff e escopo', () => {
  it('alteracao fora de touches reprova com o caminho listado', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const ws = await provider.acquire(lease({ touches: ['packages/a/'] }))
    await write(ws.path, 'packages/b/b.ts', 'export const b = 2\n')

    const observation = await provider.diff(ws)

    expect(observation.scopeCheck).toBe('VIOLATION')
    expect(observation.outOfScopePaths).toEqual(['packages/b/b.ts'])
  })

  it('alteracao em denyPaths reprova mesmo dentro de touches', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const ws = await provider.acquire(lease({ touches: ['.agentic/'], deny: ['.agentic/'] }))
    await write(ws.path, '.agentic/project.yaml', 'hack: true\n')
    await rm(join(ws.path, '.gitignore'))

    const observation = await provider.diff(ws)

    expect(observation.scopeCheck).toBe('VIOLATION')
    expect(observation.outOfScopePaths).toContain('.agentic/project.yaml')
  })

  it('arquivo novo nao rastreado entra na observacao e no patch', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const ws = await provider.acquire(lease())
    await write(ws.path, 'packages/a/novo.ts', 'export const novo = 1\n')

    const observation = await provider.diff(ws)

    expect(observation.filesChanged).toEqual([
      { path: 'packages/a/novo.ts', change: 'A', added: 1, removed: 0 },
    ])
    expect(observation.diffStat).toEqual({ files: 1, added: 1, removed: 0 })
    expect(observation.patch).toContain('packages/a/novo.ts')
    expect(observation.patch).toContain('+export const novo = 1')
  })

  it('exige lease ativo para observar', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const ws = await provider.acquire(lease())
    await provider.release(ws, 'keep')
    await expect(provider.diff(ws)).rejects.toThrow(/lease/)
  })
})

describe('commit', () => {
  it('commita apenas o que esta no escopo e devolve o sha', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const ws = await provider.acquire(lease({ touches: ['packages/a/'] }))
    await write(ws.path, 'packages/a/a.ts', 'export const a = 2\n')
    await write(ws.path, 'packages/b/b.ts', 'export const b = 99\n')

    const commit = await provider.commit(ws, 'T01: altera a')

    expect(commit.changed).toBe(true)
    expect(isNoChanges(commit)).toBe(false)
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(commit.branch).toBe('task/DA-CORE-001/T01/a1')
    const { stdout } = await exec('git', ['show', '--name-only', '--format=', commit.sha], {
      cwd: ws.path,
    })
    expect(stdout.trim().split('\n')).toEqual(['packages/a/a.ts'])
  })

  it('sem alteracao devolve resultado mapeavel para NO_CHANGES', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const ws = await provider.acquire(lease())

    const commit = await provider.commit(ws, 'T01: nada')

    expect(commit.changed).toBe(false)
    expect(isNoChanges(commit)).toBe(true)
    expect(commit.sha).toBe(await repo.git('rev-parse', 'mission/DA-CORE-001'))
  })

  it('escopo que ainda nao existe na arvore nao derruba o commit do resto', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    // Task que cria pacote novo declara `touches` do que vai nascer: o caminho ainda nao
    // existe na worktree e `git add` recusaria o pathspec, perdendo o trabalho valido.
    const ws = await provider.acquire(lease({ touches: ['packages/a/', 'packages/novo/'] }))
    await write(ws.path, 'packages/a/a.ts', 'export const a = 42\n')

    const commit = await provider.commit(ws, 'T01: altera a')

    expect(commit.changed).toBe(true)
    const { stdout } = await exec('git', ['show', '--name-only', '--format=', commit.sha], {
      cwd: ws.path,
    })
    expect(stdout.trim().split('\n')).toEqual(['packages/a/a.ts'])
  })

  it('escopo inteiro inexistente e sem trabalho e NO_CHANGES, nao WORKSPACE_ERROR', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const ws = await provider.acquire(lease({ touches: ['packages/novo/'] }))

    const commit = await provider.commit(ws, 'T01: nada')

    expect(isNoChanges(commit)).toBe(true)
    expect(commit.sha).toBe(await repo.git('rev-parse', 'mission/DA-CORE-001'))
  })

  it('sem alteracao apos observar tambem e NO_CHANGES', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const ws = await provider.acquire(lease())
    await provider.diff(ws)
    expect(isNoChanges(await provider.commit(ws, 'T01: nada'))).toBe(true)
  })
})

describe('release', () => {
  it('discard remove a worktree do disco e do registro do git', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const ws = await provider.acquire(lease())

    await provider.release(ws, 'discard')

    expect(await stat(ws.path).catch(() => null)).toBeNull()
    const entries = await listWorktrees(repo.root)
    expect(entries.some((entry) => entry.path === ws.path)).toBe(false)
  })

  it('keep preserva a worktree para pericia', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const ws = await provider.acquire(lease())
    await write(ws.path, 'packages/a/a.ts', 'export const a = 2\n')

    await provider.release(ws, 'keep')

    expect((await stat(ws.path)).isDirectory()).toBe(true)
    expect(await readFile(join(ws.path, 'packages/a/a.ts'), 'utf8')).toBe('export const a = 2\n')
    const entries = await listWorktrees(repo.root)
    expect(entries.some((entry) => entry.path === ws.path)).toBe(true)
  })
})

describe('worktree da missao', () => {
  it('abre a branch da missao com o mesmo workspaceSetup', async () => {
    repo = await createTestRepo()
    await mkdir(join(repo.root, 'node_modules'), { recursive: true })
    const provider = providerFor(repo.root, { workspaceSetup: { link: ['node_modules'] } })
    const ws = await provider.acquireMissionWorkspace({
      runId: RUN,
      attemptId: attemptId(`${RUN}:mission`),
    })

    expect(ws.branch).toBe('mission/DA-CORE-001')
    expect(provider.setupOf(ws)?.linked).toEqual(['node_modules'])
    expect((await stat(join(ws.path, 'node_modules'))).isDirectory()).toBe(true)
  })

  /**
   * D2. O gate da missao julga um COMMIT. Quando alguem ja tem a branch em check-out — o
   * proprio repositorio orquestrado, no dogfooding — `git worktree add <path> <branch>`
   * falha com exit 128; a aquisicao passa a detach sobre o mesmo sha em vez de disputar o
   * ref, e com a branch livre nada muda.
   */
  it('com a branch da missao LIVRE, mantem a worktree anexada a ela', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    const ws = await provider.acquireMissionWorkspace({
      runId: RUN,
      attemptId: attemptId(`${RUN}:mission`),
    })

    expect(ws.branch).toBe('mission/DA-CORE-001')
    const head = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws.path })
    expect(head.stdout.trim()).toBe('mission/DA-CORE-001')
    expect(ws.baseCommit).toBe(await repo.git('rev-parse', 'mission/DA-CORE-001'))
  })

  it('com a branch da missao JA em check-out, adquire detached sobre o mesmo sha', async () => {
    repo = await createTestRepo()
    const provider = providerFor(repo.root)
    await provider.ensureMissionBranch()
    // A arvore principal assume a branch da missao: topologia do dogfooding.
    await repo.git('checkout', 'mission/DA-CORE-001')
    const missionSha = await repo.git('rev-parse', 'mission/DA-CORE-001')

    const ws = await provider.acquireMissionWorkspace({
      runId: RUN,
      attemptId: attemptId(`${RUN}:mission`),
    })

    // Sem branch anexada: dizer que HEAD esta na branch seria mentir sobre a arvore.
    expect(ws.branch).toBeUndefined()
    const head = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws.path })
    expect(head.stdout.trim()).toBe('HEAD')
    // Mesma ARVORE, que e o que o gate julga.
    expect(ws.baseCommit).toBe(missionSha)
    const worktreeSha = await exec('git', ['rev-parse', 'HEAD'], { cwd: ws.path })
    expect(worktreeSha.stdout.trim()).toBe(missionSha)
    // E quem ja segurava a branch continua segurando.
    expect(await repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('mission/DA-CORE-001')
  })
})
