import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProviderRegistry, RunId } from '@agentic/domain'
import type { ControlPlane, Orchestrator } from '@agentic/orchestrator'
import { createControlPlane } from '@agentic/orchestrator'
import type { GatesFile, ProjectFile } from '@agentic/schemas'
import { parseGatesFile, parseProjectFile } from '@agentic/schemas'
import type { FastifyInstance } from 'fastify'
import type { RunLauncher, ServerDeps } from '../deps.js'
import { toServerDeps } from '../deps.js'
import { createServer } from '../server.js'
import {
  CLEAN_MISSION,
  GATE_ALWAYS_PASS,
  type MissionFixture,
  type ProjectFixture,
  gatesYaml,
  missionYaml,
  projectYaml,
} from './files.js'

const exec = promisify(execFile)

export const ACTOR = 'humano@teste'

export interface MockStepFixture {
  readonly status: 'completed'
  readonly claims: { readonly summary: string }
  readonly writeFiles: Readonly<Record<string, string>>
}

/** Roteiro do agente de mentira: escreve dentro do `touches` declarado da task. */
export function mockScripts(
  tasks: readonly string[],
): Readonly<Record<string, Readonly<Record<string, MockStepFixture>>>> {
  const script: Record<string, MockStepFixture> = {}
  for (const task of tasks) {
    script[task] = {
      status: 'completed',
      claims: { summary: `${task}: alteracao aplicada` },
      writeFiles: {
        [`packages/${task.toLowerCase()}/${task}.ts`]: `export const ${task} = 1\n`,
      },
    }
  }
  return { mock: script }
}

export interface HarnessOptions {
  readonly missions?: readonly MissionFixture[]
  readonly project?: ProjectFixture
  readonly gates?: Readonly<Record<string, readonly string[]>>
  /** Registry alternativo — usado para provar que `unknown` atravessa como `unknown`. */
  readonly registry?: ProviderRegistry
  readonly webDist?: string
  readonly heartbeatMs?: number
  /** Por padrao o launcher e um espiao: o teste dirige o loop na mao com `drain`. */
  readonly realLauncher?: boolean
}

export interface ServerHarness {
  readonly root: string
  readonly app: FastifyInstance
  readonly plane: ControlPlane
  readonly deps: ServerDeps
  readonly project: ProjectFile
  readonly gatesFile: GatesFile
  /** Runs cuja orquestracao o servidor mandou comecar. */
  readonly launched: RunId[]
  missionFile(id: string): string
  open(runId: string): Promise<Orchestrator>
  drain(runId: string): Promise<void>
  cleanup(): Promise<void>
}

async function seedRepository(root: string): Promise<void> {
  const git = async (...args: string[]): Promise<void> => {
    await exec('git', args, { cwd: root })
  }
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.name', 'Orquestrador Teste')
  await git('config', 'user.email', 'teste@example.invalid')
  await git('config', 'commit.gpgsign', 'false')
  await writeFile(join(root, '.gitignore'), '.agentic/\nnode_modules/\n', 'utf8')
  await writeFile(join(root, 'README.md'), 'base\n', 'utf8')
  await git('add', '-A')
  await git('commit', '--no-verify', '-q', '-m', 'init')
}

/**
 * Repositorio git temporario + control plane real sobre banco proprio + servidor por
 * `inject`. Nenhuma porta e aberta e nenhum agente real e invocado: todo agente e o mock.
 */
export async function createServerHarness(
  options: HarnessOptions = {},
): Promise<ServerHarness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentic-server-')))
  await seedRepository(root)
  await mkdir(join(root, '.agentic', 'missions'), { recursive: true })

  const projectText = projectYaml(options.project)
  const gatesText = gatesYaml(options.gates ?? { unit: [GATE_ALWAYS_PASS] })
  await writeFile(join(root, '.agentic', 'project.yaml'), projectText, 'utf8')
  await writeFile(join(root, '.agentic', 'gates.yaml'), gatesText, 'utf8')

  const missions = options.missions ?? [CLEAN_MISSION]
  const taskIds = new Set<string>()
  for (const mission of missions) {
    const id = mission.id ?? 'DA-SRV-001'
    await writeFile(
      join(root, '.agentic', 'missions', `${id}.mission.yaml`),
      missionYaml(mission),
      'utf8',
    )
    for (const task of mission.tasks) taskIds.add(task.id)
  }

  const project = parseProjectFile(projectText)
  if (!project.ok) throw new Error(`project.yaml invalido: ${JSON.stringify(project.issues)}`)
  const gates = parseGatesFile(gatesText)
  if (!gates.ok) throw new Error(`gates.yaml invalido: ${JSON.stringify(gates.issues)}`)

  const plane = createControlPlane({
    project: project.value,
    gatesFile: gates.value,
    repoRoot: root,
    baseDir: join(root, '.agentic'),
    safetyIntervalMs: 0,
    scripts: mockScripts([...taskIds]),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  })

  const launched: RunId[] = []
  const spy: RunLauncher = {
    start: async (runId: RunId): Promise<void> => {
      launched.push(runId)
    },
  }

  const deps = toServerDeps({
    plane,
    project: project.value,
    projectText,
    gatesText,
    repoRoot: root,
    ...(options.webDist === undefined ? {} : { webDist: options.webDist }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.realLauncher === true ? {} : { launcher: spy }),
  })
  const app = createServer(deps)

  return {
    root,
    app,
    plane,
    deps,
    project: project.value,
    gatesFile: gates.value,
    launched,
    missionFile: (id: string): string => `.agentic/missions/${id}.mission.yaml`,
    open: (runId: string) => plane.open(runId as RunId),
    drain: async (runId: string): Promise<void> => {
      const orchestrator = await plane.open(runId as RunId)
      await orchestrator.drain()
    },
    cleanup: async (): Promise<void> => {
      await app.close().catch(() => undefined)
      await plane.close().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    },
  }
}
