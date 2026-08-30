import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureDeps,
  createWorkspace,
  MISSION_WITH_ERROR,
  type Workspace,
} from '../__fixtures__/harness.js'
import { EXIT_ERROR, EXIT_OK } from '../result.js'
import { type CompileData, missionCompileCommand } from './mission-compile.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const REAL_MISSION = join(REPO_ROOT, '.agentic/missions/DA-CORE-001.mission.yaml')

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

describe('mission compile', () => {
  it('imprime fases, waves, caminho critico e conflitos', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    const result = await missionCompileCommand({ file: workspace.missionPath }, captured.deps)
    const text = captured.stdout()

    expect(result.exitCode).toBe(EXIT_OK)
    expect(text).toContain('tasks por fase')
    expect(text).toContain('waves (earliest start)')
    expect(text).toContain('caminho critico')
    expect(text).toContain('conflitos de touches: 0')
  })

  it('compila a missao REAL do repositorio com as waves do plano', async () => {
    const captured = captureDeps({ cwd: REPO_ROOT })
    const result = await missionCompileCommand({ file: REAL_MISSION }, captured.deps)
    const text = captured.stdout()

    expect(result.exitCode).toBe(EXIT_OK)
    expect(text).toContain('1. T01')
    expect(text).toContain('2. T02 T04 T16')
    expect(text).toContain('8. T15')
  })

  it('reproduz o caminho critico de comprimento 40 da missao real', async () => {
    const captured = captureDeps({ cwd: REPO_ROOT })
    const result = await missionCompileCommand({ file: REAL_MISSION }, captured.deps)
    const data = result.data as CompileData

    expect(data.graph?.criticalPath.length).toBe(40)
    expect(data.graph?.criticalPath.tasks).toEqual([
      'T01',
      'T02',
      'T03',
      'T05',
      'T10',
      'T11',
      'T13',
      'T15',
    ])
    expect(captured.stdout()).toContain('caminho critico (8 tasks, comprimento 40)')
  })

  it('reproduz os 50 pares concorrentes e zero conflito da missao real', async () => {
    const captured = captureDeps({ cwd: REPO_ROOT })
    const result = await missionCompileCommand({ file: REAL_MISSION }, captured.deps)
    const data = result.data as CompileData

    expect(data.graph?.concurrentPairs).toHaveLength(50)
    expect(data.graph?.touchConflicts).toEqual([])
    expect(captured.stdout()).toContain('pares concorrentes: 50')
  })

  it('sai 1 sem grafo quando ha ERROR', async () => {
    workspace = await createWorkspace({ mission: MISSION_WITH_ERROR })
    const captured = captureDeps({ cwd: workspace.dir })
    const result = await missionCompileCommand({ file: workspace.missionPath }, captured.deps)
    const data = result.data as CompileData

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(result.error?.code).toBe('COMPILE_FAILED')
    expect(data.graph).toBeUndefined()
    expect(captured.stdout()).toContain('DA1003')
  })

  it('--json carrega report e grafo, e nao escreve texto humano', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    const result = await missionCompileCommand(
      { file: workspace.missionPath, json: true },
      captured.deps,
    )
    const data = result.data as CompileData

    expect(captured.stdout()).toBe('')
    expect(data.report.missionId).toBe('TESTE-001')
    expect(data.graph?.waves).toEqual([['T01'], ['T02', 'T03']])
    expect(data.graph?.tasksByPhase).toEqual([
      { phase: 'base', tasks: ['T01'] },
      { phase: 'fim', tasks: ['T02', 'T03'] },
    ])
  })
})
