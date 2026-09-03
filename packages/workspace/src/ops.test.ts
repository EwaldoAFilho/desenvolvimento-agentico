import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathScope } from '@agentic/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestRepo, type TestRepo } from './__fixtures__/repo.js'
import { commitWorkingTree, observeWorkingTree } from './ops.js'

const scope = (touches: string[]) => ({
  touches: touches.map(pathScope),
  denyPaths: ['.agentic/'].map(pathScope),
})

let repo: TestRepo | undefined
afterEach(async () => {
  await repo?.cleanup()
  repo = undefined
})

/**
 * Estes testes fixam a INVARIANTE do commit de tentativa: o que a tentativa criou entra no
 * commit, e o caminho linkado nao entra. Eles nao reproduzem o defeito que motivou a
 * correcao — e isso esta dito aqui de proposito.
 *
 * O defeito, observado em DA-UX-001/U02 (tentativas a1 e a2): o commit estagiava com
 * `git add -A -- <touches> :(exclude)<link>` e, na worktree da tentativa, esse comando
 * estagiava ZERO arquivo novo e saia 0 — enquanto `git ls-files --others` com os mesmos
 * pathspecs listava o arquivo, que e justamente o que matchingSpecs consulta para decidir
 * que o escopo casa. Resultado: commit sem nada do que a tentativa criou, com o gate
 * passando na arvore suja. PASS atribuido a um commit que nem compila.
 *
 * O mecanismo no git NAO foi isolado. Tentei reproduzir em repositorio comum, em worktree
 * vinculada, com link real e com symlink, com pathspec literal e de diretorio: em nenhum
 * desses o `:(exclude)` suprime o arquivo novo. So reproduz nas worktrees deste repositorio
 * (git 2.53.0). Por isso a correcao nao depende de explicar o mecanismo: ela deixa de usar
 * `:(exclude)` no staging e passa a desestagiar o link explicitamente, que da a mesma
 * garantia sem depender da interacao de pathspec.
 */
describe('commitWorkingTree: o que a tentativa criou entra no commit', () => {
  it('commita o arquivo NOVO criado pela tentativa mesmo havendo link declarado', async () => {
    repo = await createTestRepo()
    const links = ['node_modules']
    const externo = join(repo.root, '..', `alvo1-${process.pid}`)
    await mkdir(externo, { recursive: true })
    await writeFile(join(externo, 'lixo.js'), 'x\n', 'utf8')
    await symlink(externo, join(repo.root, 'node_modules'))
    await repo.write('packages/a/novo.ts', 'export const novo = 1\n')
    await repo.write('packages/a/a.ts', 'export const a = 2\n')

    const commit = await commitWorkingTree({
      cwd: repo.root,
      message: 'tentativa',
      scope: scope(['packages/a/']),
      links,
    })

    expect(commit.changed).toBe(true)
    const arquivos = (await repo.git('show', '--name-only', '--format=', 'HEAD'))
      .split('\n')
      .filter((line) => line.length > 0)
      .sort()
    expect(arquivos).toEqual(['packages/a/a.ts', 'packages/a/novo.ts'])
  })

  it('commita arquivo NOVO quando o escopo lista arquivos, nao diretorios', async () => {
    repo = await createTestRepo()
    const externo = join(repo.root, '..', `alvo2-${process.pid}`)
    await mkdir(externo, { recursive: true })
    await writeFile(join(externo, 'lixo.js'), 'x\n', 'utf8')
    await symlink(externo, join(repo.root, 'node_modules'))
    await repo.write('packages/a/novo.ts', 'export const novo = 1\n')

    const commit = await commitWorkingTree({
      cwd: repo.root,
      message: 'tentativa',
      // Escopo so de arquivo: era exatamente a forma que perdia o arquivo novo.
      scope: scope(['packages/a/novo.ts', 'packages/a/a.ts']),
      links: ['node_modules'],
    })

    expect(commit.changed).toBe(true)
    const arquivos = await repo.git('show', '--name-only', '--format=', 'HEAD')
    expect(arquivos).toContain('packages/a/novo.ts')
  })

  it('nao commita o caminho linkado, mesmo quando o escopo o contem', async () => {
    repo = await createTestRepo()
    const alvo = join(repo.root, 'fora')
    await mkdir(alvo, { recursive: true })
    await writeFile(join(alvo, 'build.js'), 'x\n', 'utf8')
    await mkdir(join(repo.root, 'packages/a'), { recursive: true })
    await symlink(alvo, join(repo.root, 'packages/a/dist'))
    await repo.write('packages/a/novo.ts', 'export const novo = 1\n')

    const commit = await commitWorkingTree({
      cwd: repo.root,
      message: 'tentativa',
      scope: scope(['packages/a/']),
      links: ['packages/a/dist'],
    })

    expect(commit.changed).toBe(true)
    const arquivos = await repo.git('show', '--name-only', '--format=', 'HEAD')
    expect(arquivos).toContain('packages/a/novo.ts')
    expect(arquivos).not.toContain('packages/a/dist')
  })

  it('a verificacao de escopo enxerga o arquivo novo (caminho do diff intacto)', async () => {
    repo = await createTestRepo()
    // O produto cria o link como SYMLINK para fora da arvore (workspaceSetup.link).
    const externo = join(repo.root, '..', `alvo-${process.pid}`)
    await mkdir(externo, { recursive: true })
    await writeFile(join(externo, 'lixo.js'), 'x\n', 'utf8')
    await symlink(externo, join(repo.root, 'node_modules'))
    await repo.write('packages/a/novo.ts', 'export const novo = 1\n')
    const base = await repo.git('rev-parse', 'HEAD')

    const observation = await observeWorkingTree({
      cwd: repo.root,
      baseCommit: base,
      scope: scope(['packages/a/']),
      links: ['node_modules'],
    })

    const alterados = observation.filesChanged.map((c) => c.path)
    expect(alterados).toContain('packages/a/novo.ts')
    expect(alterados).not.toContain('node_modules/lixo.js')
    expect(observation.outOfScopePaths).toEqual([])
  })
})
