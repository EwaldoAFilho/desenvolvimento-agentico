import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { discoverLive } from './core/discovery.js'
import { launchServe, type SpawnedProcess } from './core/launcher.js'
import { AgenticService, type ServiceDeps } from './core/service.js'
import type { Toolchain } from './core/toolchain.js'

/**
 * Duas janelas, um projeto, um control plane — com processos DE VERDADE.
 *
 * Cada `AgenticService` faz o papel de uma janela do editor. A CLI e a MESMA que a extensao
 * executa em uso real: `apps/cli/bin/agentic.mjs` (dist). Rodar o fonte por `vite-node`
 * nao serve aqui: o runner intercepta SIGTERM e derruba o processo antes do encerramento
 * gracioso, e este teste mede exatamente esse encerramento. Sem dist, o `beforeAll` compila
 * a CLI (incremental: rapido quando ja ha build).
 *
 * O que se prova: a segunda janela reutiliza o dono da primeira em vez de subir outro; o
 * `stop` da segunda encerra o processo da primeira de forma graciosa e provada; projetos
 * diferentes tem donos independentes.
 */
const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '../../..')
const CLI_BIN = join(REPO_ROOT, 'apps/cli/bin/agentic.mjs')
const CLI_DIST = join(REPO_ROOT, 'apps/cli/dist/index.js')

const toolchain: Toolchain = {
  node: { path: process.execPath, version: process.version },
  cli: { kind: 'script', path: CLI_BIN, source: 'repo' },
  command: (args) => ({ file: process.execPath, args: [CLI_BIN, ...args] }),
}

async function exec(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString()
    })
    child.stderr.on('data', (c: Buffer) => {
      out += c.toString()
    })
    child.on('exit', (code) =>
      code === 0
        ? resolvePromise(out)
        : reject(new Error(`${command} ${args.join(' ')} saiu ${code}:\n${out}`)),
    )
  })
}

interface Project {
  readonly root: string
  readonly port: number
}

async function newProject(port: number): Promise<Project> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agentic-vscode-mw-')))
  await exec('git', ['init', '-q'], dir)
  await exec(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    dir,
  )
  await exec(process.execPath, [CLI_BIN, 'init', '--json', dir], REPO_ROOT)
  const projectFile = join(dir, '.agentic', 'project.yaml')
  const text = await readFile(projectFile, 'utf8')
  await writeFile(projectFile, text.replace(/port:\s*\d+/, `port: ${port}`))
  return { root: dir, port }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const spawned: SpawnedProcess[] = []

function windowFor(project: Project, label: string): AgenticService {
  const deps: ServiceDeps = {
    discover: () =>
      discoverLive(
        {
          runtimeDir: join(project.root, '.agentic'),
          repoRoot: project.root,
          declaredUrl: `http://127.0.0.1:${project.port}`,
        },
        {
          readFile: (path) => readFile(path, 'utf8').catch(() => undefined),
          alive: (pid) => {
            try {
              process.kill(pid, 0)
              return true
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === 'EPERM'
            }
          },
          fetchHealth: async (url) => {
            try {
              const response = await fetch(`${url}/api/health`, {
                signal: AbortSignal.timeout(750),
              })
              return response.ok
                ? ((await response.json()) as { service?: unknown; repoRoot?: unknown })
                : undefined
            } catch {
              return undefined
            }
          },
          canonical: (path) => path,
        },
      ),
    spawnServe: () => {
      const child = launchServe({ toolchain, repoRoot: project.root, env: { ...process.env } })
      spawned.push(child)
      return Promise.resolve(child)
    },
    signal: (pid, signal) => {
      try {
        process.kill(pid, signal)
        return true
      } catch {
        return false
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    log: (line) => {
      if (process.env.AGENTIC_TEST_VERBOSE !== undefined) console.log(`[${label}] ${line}`)
    },
    timeouts: { startMs: 45_000, stopMs: 20_000, pollMs: 200 },
  }
  return new AgenticService(deps)
}

const projects: Project[] = []

beforeAll(async () => {
  if (!(await exists(CLI_DIST))) {
    await exec(
      process.execPath,
      [join(REPO_ROOT, 'node_modules/typescript/bin/tsc'), '--build', 'apps/cli'],
      REPO_ROOT,
    )
  }
  projects.push(await newProject(45411), await newProject(45412))
}, 240_000)

afterAll(async () => {
  for (const child of spawned) {
    if (!child.done) {
      child.kill('SIGTERM')
      await Promise.race([child.exited, new Promise((r) => setTimeout(r, 10_000))])
    }
  }
  for (const project of projects) await rm(project.root, { recursive: true, force: true })
})

describe('varias janelas do editor sobre o mesmo projeto', () => {
  it('a segunda janela reutiliza o control plane da primeira; o stop dela encerra o processo de fato', async () => {
    const project = projects[0]
    if (project === undefined) throw new Error('fixture')
    const janelaA = windowFor(project, 'A')
    const janelaB = windowFor(project, 'B')

    const a = await janelaA.ensureRunning()
    expect(a.state).toBe('RUNNING')
    expect(a.owned).toBe(true)
    expect(a.live?.url).toBe(`http://127.0.0.1:${project.port}`)

    const b = await janelaB.ensureRunning()
    expect(b.state).toBe('RUNNING')
    expect(b.owned).toBe(false)
    expect(b.live?.pid).toBe(a.live?.pid)
    expect(spawned).toHaveLength(1)

    const stopped = await janelaB.stop()
    expect(stopped.state).toBe('STOPPED')
    // O processo da janela A saiu de verdade (nao apenas "sinal enviado"): o silencio do
    // health e a prova que o stop exige; a saida do processo vem logo atras.
    await Promise.race([spawned[0]?.exited, new Promise((r) => setTimeout(r, 5_000))])
    expect(spawned[0]?.done).toBe(true)
    expect((await janelaA.refresh()).state).toBe('STOPPED')
    // E a descoberta nao guarda lixo: o dono retirou o proprio registro.
    await expect(
      readFile(join(project.root, '.agentic', 'control-plane.json'), 'utf8'),
    ).rejects.toBeDefined()
  }, 120_000)

  it('projetos diferentes tem control planes independentes', async () => {
    const [p1, p2] = projects
    if (p1 === undefined || p2 === undefined) throw new Error('fixture')
    const janela1 = windowFor(p1, 'P1')
    const janela2 = windowFor(p2, 'P2')
    const v1 = await janela1.ensureRunning()
    const v2 = await janela2.ensureRunning()
    expect(v1.owned).toBe(true)
    expect(v2.owned).toBe(true)
    expect(v1.live?.pid).not.toBe(v2.live?.pid)
    expect((await janela1.stop()).state).toBe('STOPPED')
    expect((await janela2.refresh()).state).toBe('RUNNING')
    expect((await janela2.stop()).state).toBe('STOPPED')
  }, 120_000)
})
