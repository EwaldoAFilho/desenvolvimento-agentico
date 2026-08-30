import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestRepo, sharedLease, type TestRepo } from './__fixtures__/repo.js'
import { isWorkspaceBusyError } from './errors.js'
import { isNoChanges } from './ops.js'
import { SharedWorkspaceProvider } from './shared-provider.js'

let repo: TestRepo | undefined

afterEach(async () => {
  await repo?.cleanup()
  repo = undefined
})

describe('SharedWorkspaceProvider', () => {
  it('entrega a arvore unica com o commit corrente como base', async () => {
    repo = await createTestRepo()
    const provider = new SharedWorkspaceProvider({ root: repo.root })

    const ws = await provider.acquire(sharedLease())

    expect(ws.kind).toBe('shared')
    expect(ws.path).toBe(repo.root)
    expect(ws.branch).toBe('main')
    expect(ws.baseCommit).toBe(await repo.git('rev-parse', 'HEAD'))
  })

  it('serializa: o segundo acquire so entra depois do release', async () => {
    repo = await createTestRepo()
    const provider = new SharedWorkspaceProvider({ root: repo.root })
    const primeiro = await provider.acquire(sharedLease({ task: 'T01' }))

    let segundoPronto = false
    const segundo = provider.acquire(sharedLease({ task: 'T02' })).then((ws) => {
      segundoPronto = true
      return ws
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(segundoPronto).toBe(false)
    expect(provider.busy).toBe(true)

    await provider.release(primeiro, 'keep')
    const ws = await segundo

    expect(segundoPronto).toBe(true)
    expect(ws.leasedBy).not.toBe(primeiro.leasedBy)
  })

  it('com onBusy fail o segundo acquire falha de forma explicita', async () => {
    repo = await createTestRepo()
    const provider = new SharedWorkspaceProvider({ root: repo.root, onBusy: 'fail' })
    await provider.acquire(sharedLease({ task: 'T01' }))

    await expect(provider.acquire(sharedLease({ task: 'T02' }))).rejects.toSatisfy(
      isWorkspaceBusyError,
    )
  })

  it('release devolve o lease uma unica vez', async () => {
    repo = await createTestRepo()
    const provider = new SharedWorkspaceProvider({ root: repo.root, onBusy: 'fail' })
    const ws = await provider.acquire(sharedLease())
    await provider.release(ws, 'keep')
    await provider.release(ws, 'keep')
    const outro = await provider.acquire(sharedLease({ task: 'T02' }))
    expect(outro.id).not.toBe(ws.id)
    expect(provider.busy).toBe(true)
  })

  it('verifica escopo e commita na arvore compartilhada', async () => {
    repo = await createTestRepo()
    const provider = new SharedWorkspaceProvider({ root: repo.root })
    const ws = await provider.acquire(sharedLease({ touches: ['packages/a/'] }))
    await repo.write('packages/a/a.ts', 'export const a = 9\n')

    const observation = await provider.diff(ws)
    const commit = await provider.commit(ws, 'shared: altera a')

    expect(observation.scopeCheck).toBe('PASS')
    expect(observation.filesChanged.map((c) => c.path)).toEqual(['packages/a/a.ts'])
    expect(commit.changed).toBe(true)
    expect(await repo.git('rev-parse', 'HEAD')).toBe(commit.sha)
  })

  it('sem alteracao devolve resultado mapeavel para NO_CHANGES', async () => {
    repo = await createTestRepo()
    const provider = new SharedWorkspaceProvider({ root: repo.root })
    const ws = await provider.acquire(sharedLease())
    expect(isNoChanges(await provider.commit(ws, 'nada'))).toBe(true)
  })

  it('roda workspaceSetup sem tentar ligar a arvore a si mesma', async () => {
    repo = await createTestRepo()
    await mkdir(join(repo.root, 'node_modules'), { recursive: true })
    await writeFile(join(repo.root, 'marca.txt'), 'antes\n', 'utf8')
    const provider = new SharedWorkspaceProvider({
      root: repo.root,
      workspaceSetup: { link: ['node_modules'], commands: ['echo depois > marca.txt'] },
    })

    const ws = await provider.acquire(sharedLease())

    expect(provider.setupOf(ws)?.skipped).toEqual([{ name: 'node_modules', reason: 'same-path' }])
    expect(await repo.read('marca.txt')).toContain('depois')
  })

  it('arvore sem git recusa diff em vez de aprovar escopo em silencio', async () => {
    repo = await createTestRepo(false)
    const provider = new SharedWorkspaceProvider({ root: repo.root })
    const ws = await provider.acquire(sharedLease())
    await expect(provider.diff(ws)).rejects.toThrow(/nao e repositorio git/)
    await expect(provider.commit(ws, 'x')).rejects.toThrow(/nao e repositorio git/)
  })
})
