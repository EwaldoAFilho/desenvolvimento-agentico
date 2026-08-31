import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { captureDeps, createWorkspace, type Workspace } from './__fixtures__/harness.js'
import { main } from './program.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const REAL_MISSION = join(REPO_ROOT, '.agentic/missions/DA-CORE-001.mission.yaml')

/**
 * O `--json` e contrato publicado: script de terceiro le esses campos, entao renomear um
 * deles e quebra incompativel.
 *
 * Este arquivo existe por um achado de revisao: uma mutacao renomeou tres campos de payload
 * e a suite inteira continuou verde. Fixar o TIPO nao basta — a mutacao renomeia tipo e uso
 * juntos e o typecheck passa. Por isso o teste le a SAIDA REALMENTE EMITIDA pelo comando.
 */
const keysOf = (value: unknown): string[] =>
  typeof value === 'object' && value !== null ? Object.keys(value).sort() : []

const payloadOf = (captured: { json(): unknown }): Record<string, unknown> => {
  const envelope = captured.json() as { ok: boolean; command: string; data: unknown }
  expect(keysOf(envelope)).toEqual(['command', 'data', 'ok'])
  return envelope.data as Record<string, unknown>
}

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

describe('contrato do --json (saida real dos comandos)', () => {
  it('mission compile emite o DAG com os nomes publicados', async () => {
    // cwd = repositorio real: a missao referencia os gates de .agentic/gates.yaml
    const captured = captureDeps({ cwd: REPO_ROOT })
    await main(['node', 'agentic', 'mission', 'compile', REAL_MISSION, '--json'], captured.deps)

    const data = payloadOf(captured)
    expect(keysOf(data)).toEqual(['graph', 'report'])

    const graph = data.graph as Record<string, unknown>
    expect(keysOf(graph)).toEqual([
      'concurrentPairs',
      'criticalPath',
      'tasksByPhase',
      'topologicalOrder',
      'touchConflicts',
      'waves',
    ])
    expect(keysOf(graph.criticalPath)).toEqual(['length', 'tasks'])

    // O conteudo tambem e contrato: e a missao real deste repositorio.
    const critical = graph.criticalPath as { tasks: string[]; length: number }
    expect(critical.length).toBe(40)
    expect(critical.tasks).toEqual(['T01', 'T02', 'T03', 'T05', 'T10', 'T11', 'T13', 'T15'])
    expect((graph.topologicalOrder as string[]).length).toBe(17)
  })

  it('serve emite o endereco com os nomes publicados', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: () =>
        Promise.resolve({ url: 'http://127.0.0.1:4317', close: () => Promise.resolve() }),
    })
    await main(['node', 'agentic', 'serve', '--json'], captured.deps)

    const data = payloadOf(captured)
    expect(keysOf(data)).toEqual(['endpoint', 'running'])
  })

  it('o launcher emite projeto, endereco, reuso, navegador e diagnostico', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      bootServer: () =>
        Promise.resolve({ url: 'http://127.0.0.1:4317', close: () => Promise.resolve() }),
      openBrowser: () => Promise.resolve({ opened: false, reason: 'sem ambiente grafico' }),
    })
    // `agentic --json`: a reescrita para o launcher tem que preservar a flag.
    await main(['node', 'agentic', '--json'], captured.deps)

    const data = payloadOf(captured)
    expect(keysOf(data)).toEqual(['browser', 'checks', 'endpoint', 'projectDir', 'reused'])
    expect(keysOf(data.browser)).toEqual(['opened', 'reason'])
    expect(keysOf((data.checks as unknown[])[0])).toEqual(['detail', 'id', 'status', 'title'])
  })
})
