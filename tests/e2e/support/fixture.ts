import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const here = dirname(fileURLToPath(import.meta.url))

/** Projeto-alvo versionado em `examples/`. Nao e mock: sao arquivos reais e executaveis. */
export const FIXTURE_ROOT = resolve(here, '../../../examples/estoque-cli')

export const MISSION_PATH = '.agentic/missions/EXEMPLO-001.mission.yaml'
export const PROJECT_PATH = '.agentic/project.yaml'
export const GATES_PATH = '.agentic/gates.yaml'
export const MISSION_BRANCH = 'mission/EXEMPLO-001'

export interface FixtureSources {
  readonly missionText: string
  readonly projectText: string
  readonly gatesText: string
}

export interface Fixture {
  readonly root: string
  readonly sources: FixtureSources
  git(...args: string[]): Promise<string>
  cleanup(): Promise<void>
}

export interface FixtureOptions {
  /** Transforma o `project.yaml` antes do commit inicial — ex.: remover um fornecedor. */
  readonly project?: (text: string) => string
  /** Transforma o `mission.yaml` antes do commit inicial — ex.: reduzir a uma task. */
  readonly mission?: (text: string) => string
}

async function readSources(root: string): Promise<FixtureSources> {
  const [missionText, projectText, gatesText] = await Promise.all([
    readFile(join(root, MISSION_PATH), 'utf8'),
    readFile(join(root, PROJECT_PATH), 'utf8'),
    readFile(join(root, GATES_PATH), 'utf8'),
  ])
  return { missionText, projectText, gatesText }
}

/**
 * Remove um fornecedor do `registry` do project.yaml, preservando o resto do arquivo.
 *
 * E a forma honesta de escrever "o segundo fornecedor nao existe neste ambiente": o texto
 * continua sendo o do fixture e a diferenca esta a vista no diagnostico do compilador.
 */
export function withoutProvider(projectText: string, providerId: string): string {
  const lines = projectText.split('\n')
  const start = lines.findIndex((line) => line.trimEnd() === `    ${providerId}:`)
  if (start === -1) {
    throw new Error(`fixture: provider ${providerId} nao esta declarado no project.yaml`)
  }
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line === undefined) break
    if (line.trim().length > 0 && !line.startsWith('      ')) break
    end += 1
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n')
}

/**
 * Copia o projeto de `examples/` para um diretorio temporario e inicializa um repositorio
 * git de verdade nele. O repositorio do produto nunca e usado como alvo: o E2E nao suja
 * nem depende do repositorio em que roda.
 */
export async function materializeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentic-e2e-')))
  await cp(FIXTURE_ROOT, root, { recursive: true })

  if (options.project !== undefined) {
    const original = await readFile(join(root, PROJECT_PATH), 'utf8')
    await writeFile(join(root, PROJECT_PATH), options.project(original), 'utf8')
  }
  if (options.mission !== undefined) {
    const original = await readFile(join(root, MISSION_PATH), 'utf8')
    await writeFile(join(root, MISSION_PATH), options.mission(original), 'utf8')
  }

  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await exec('git', args, { cwd: root, encoding: 'utf8' })
    return stdout.trim()
  }

  await git('init', '-q', '-b', 'main')
  await git('config', 'user.name', 'Fixture E2E')
  await git('config', 'user.email', 'e2e@example.invalid')
  await git('config', 'commit.gpgsign', 'false')
  await git('add', '-A')
  await git('commit', '--no-verify', '-q', '-m', 'estoque-cli: estado inicial')

  return {
    root,
    sources: await readSources(root),
    git,
    cleanup: async (): Promise<void> => {
      await rm(root, { recursive: true, force: true })
    },
  }
}
