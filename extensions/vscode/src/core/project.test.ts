import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { detectProject, type ProjectIo, readProjectFacts } from './project.js'

const execFileAsync = promisify(execFile)

const io: ProjectIo = {
  readFile: (path) => readFile(path, 'utf8').catch(() => undefined),
  realpath: (path) => realpath(path).catch(() => path),
  exec: async (command, args, cwd) => {
    try {
      const { stdout, stderr } = await execFileAsync(command, [...args], { cwd })
      return { code: 0, stdout, stderr }
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string }
      return {
        code: typeof failure.code === 'number' ? failure.code : 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      }
    }
  },
}

const dirs: string[] = []

async function projeto(yaml: string, git = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentic-vscode-project-'))
  dirs.push(dir)
  await mkdir(join(dir, '.agentic', 'missions'), { recursive: true })
  await writeFile(join(dir, '.agentic', 'project.yaml'), yaml)
  if (git) {
    await execFileAsync('git', ['init', '-q', '-b', 'trunk'], { cwd: dir })
    await execFileAsync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
      { cwd: dir },
    )
  }
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const YAML = `apiVersion: agentic/v1
kind: Project

project:
  name: exemplo   # comentario
  repoRoot: .

providers:
  default: mock
  registry:
    mock:
      name: nao-e-o-nome-do-projeto

server:
  host: "127.0.0.1"
  port: 4999
`

describe('readProjectFacts', () => {
  it('le so as chaves de que precisa, na secao certa', () => {
    expect(readProjectFacts(YAML)).toEqual({
      name: 'exemplo',
      repoRoot: '.',
      host: '127.0.0.1',
      port: 4999,
    })
  })

  it('arquivo sem as chaves nao quebra', () => {
    expect(readProjectFacts('kind: Project\n')).toEqual({})
    expect(readProjectFacts('project: [\n')).toEqual({})
  })

  it('apara as strings como o schema da CLI: repoRoot, name e host com espacos externos', () => {
    const facts = readProjectFacts(
      'project:\n  name: "  exemplo  "\n  repoRoot: " ../repositorio "\nserver:\n  host: " 127.0.0.1 "\n  port: 4500\n',
    )
    expect(facts).toEqual({
      name: 'exemplo',
      repoRoot: '../repositorio',
      host: '127.0.0.1',
      port: 4500,
    })
    // So espacos = ausente (o schema recusaria): nao vira caminho vazio nem nome vazio.
    expect(readProjectFacts('project:\n  name: "   "\n  repoRoot: " "\n')).toEqual({})
  })

  it('YAML valido em qualquer forma deriva os mesmos fatos que a CLI', () => {
    expect(
      readProjectFacts(
        'project: { name: "x # nao e comentario", repoRoot: ../alvo }\nserver: { port: "4500" }\n',
      ),
    ).toEqual({
      name: 'x # nao e comentario',
      repoRoot: '../alvo',
      port: 4500,
    })
    expect(
      readProjectFacts("project:\n  name: 'aspas simples'\n  repoRoot: |-\n    ../b\n"),
    ).toEqual({
      name: 'aspas simples',
      repoRoot: '../b',
    })
  })
})

describe('detectProject', () => {
  it('encontra .agentic/project.yaml subindo a partir de um subdiretorio', async () => {
    const dir = await projeto(YAML)
    await mkdir(join(dir, 'src', 'deep'), { recursive: true })
    const project = await detectProject(join(dir, 'src', 'deep'), io)
    expect(project).toBeDefined()
    expect(project?.name).toBe('exemplo')
    expect(project?.repoRoot).toBe(await realpath(dir))
    expect(project?.runtimeDir).toBe(join(await realpath(dir), '.agentic'))
    expect(project?.declaredUrl).toBe('http://127.0.0.1:4999')
    expect(project?.git).toMatchObject({ repository: true, branch: 'trunk' })
  })

  it('repoRoot com espacos externos resolve a MESMA identidade que a CLI e o mesmo endpoint', async () => {
    const dir = await projeto(
      YAML.replace('repoRoot: .', 'repoRoot: " ../alvo "').replace(
        'host: "127.0.0.1"',
        'host: " 127.0.0.1 "',
      ),
    )
    await mkdir(join(dir, '..', 'alvo'), { recursive: true }).catch(() => undefined)
    const project = await detectProject(dir, io)
    expect(project?.repoRoot).toBe(join(await realpath(join(dir, '..')), 'alvo'))
    expect(project?.declaredUrl).toBe('http://127.0.0.1:4999')
    await rm(join(dir, '..', 'alvo'), { recursive: true, force: true })
  })

  it('repoRoot declarado fora do diretorio de configuracao e a identidade', async () => {
    const dir = await projeto(YAML.replace('repoRoot: .', 'repoRoot: ../alvo'))
    await mkdir(join(dir, '..', 'alvo'), { recursive: true }).catch(() => undefined)
    const project = await detectProject(dir, io)
    expect(project?.repoRoot).toBe(join(await realpath(join(dir, '..')), 'alvo'))
    await rm(join(dir, '..', 'alvo'), { recursive: true, force: true })
  })

  it('sem project.yaml nao ha projeto', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentic-vscode-empty-'))
    dirs.push(dir)
    expect(await detectProject(dir, io)).toBeUndefined()
  })

  it('projeto sem git continua detectado, com o fato registrado', async () => {
    const dir = await projeto(YAML, false)
    const project = await detectProject(dir, io)
    expect(project?.git.repository).toBe(false)
    expect(project?.git.branch).toBeUndefined()
  })
})
