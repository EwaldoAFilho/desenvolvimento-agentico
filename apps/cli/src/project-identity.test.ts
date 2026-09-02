import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { loadProjectSources, runtimeDirOf } from '@agentic/server'
import { afterEach, describe, expect, it } from 'vitest'
import { captureDeps, GATES_YAML, projectYaml } from './__fixtures__/harness.js'
import { loadProjectContext } from './context.js'

/**
 * UMA identidade de projeto, para todos os entrypoints (I14).
 *
 * Antes desta fatia cada comando derivava a sua: `mission start` disputava a posse em
 * `<dir do project.yaml>/.agentic` e `serve` em `<repoRoot>/.agentic`. Com `repoRoot: .`
 * os dois coincidiam por acidente; com `repoRoot` apontando para fora, viravam dois donos
 * reais para um projeto so.
 *
 * A regra que este arquivo fixa: o ESTADO (lock, `state.db`, descoberta, worktrees) mora em
 * `<repoRoot canonico>/.agentic`, e a CONFIGURACAO (`project.yaml`, `gates.yaml`) continua
 * onde o humano a escreveu.
 */

const sujeira: string[] = []

async function tmp(prefixo: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefixo)))
  sujeira.push(dir)
  return dir
}

afterEach(async () => {
  while (sujeira.length > 0) {
    const dir = sujeira.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** Config em um diretorio, repositorio em outro — `repoRoot` relativo, como o humano escreve. */
async function projetoDividido(): Promise<{ config: string; repo: string }> {
  const repo = await tmp('agentic-id-repo-')
  const config = await tmp('agentic-id-config-')
  await mkdir(join(config, '.agentic'), { recursive: true })
  const texto = projectYaml()
    .replace('  repoRoot: .', `  repoRoot: ${relative(config, repo)}`)
    .replace('  file: .agentic/gates.yaml', `  file: ${relative(config, repo)}/.agentic/gates.yaml`)
  await writeFile(join(config, '.agentic', 'project.yaml'), texto, 'utf8')
  await mkdir(join(repo, '.agentic'), { recursive: true })
  await writeFile(join(repo, '.agentic', 'gates.yaml'), GATES_YAML, 'utf8')
  return { config, repo }
}

describe('identidade do projeto', () => {
  it('com repoRoot fora, o diretorio de estado segue o REPOSITORIO', async () => {
    const { config, repo } = await projetoDividido()
    const { deps } = captureDeps({ cwd: config })
    const context = await loadProjectContext(deps)

    expect(context.repoRoot).toBe(repo)
    expect(context.runtimeDir).toBe(join(repo, '.agentic'))
    // A configuracao NAO se muda de lugar: ela continua onde o humano a escreveu.
    expect(context.baseDir).toBe(join(config, '.agentic'))
  })

  it('a chave da CLI e a mesma que o servidor deriva sozinho', async () => {
    const { config } = await projetoDividido()
    const { deps } = captureDeps({ cwd: config })
    const context = await loadProjectContext(deps)

    // `startServer` sem `runtimeDir` explicito cai neste caminho. Se as duas contas nao
    // derem o mesmo diretorio, `serve` e `mission start` disputam posses diferentes.
    const sources = await loadProjectSources({
      repoRoot: context.repoRoot,
      projectFile: context.projectPath,
    })
    expect(runtimeDirOf(sources.repoRoot)).toBe(context.runtimeDir)
  })

  it('link simbolico para o mesmo repositorio da a MESMA identidade', async () => {
    const { config, repo } = await projetoDividido()
    const atalhoDir = await tmp('agentic-id-link-')
    const atalho = join(atalhoDir, 'projeto')
    await symlink(config, atalho, 'dir')

    const direto = await loadProjectContext(captureDeps({ cwd: config }).deps)
    const pelaLink = await loadProjectContext(captureDeps({ cwd: atalho }).deps)

    expect(pelaLink.repoRoot).toBe(repo)
    expect(pelaLink.runtimeDir).toBe(direto.runtimeDir)
  })

  it('no caso normal (repoRoot: .) nada muda de lugar', async () => {
    const dir = await tmp('agentic-id-normal-')
    await mkdir(join(dir, '.agentic'), { recursive: true })
    await writeFile(join(dir, '.agentic', 'project.yaml'), projectYaml(), 'utf8')
    await writeFile(join(dir, '.agentic', 'gates.yaml'), GATES_YAML, 'utf8')

    const context = await loadProjectContext(captureDeps({ cwd: dir }).deps)
    expect(context.runtimeDir).toBe(join(dir, '.agentic'))
    expect(context.runtimeDir).toBe(context.baseDir)
  })
})
