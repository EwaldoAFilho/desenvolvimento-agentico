import { afterEach, describe, expect, it } from 'vitest'
import {
  captureDeps,
  createWorkspace,
  fakeRegistry,
  health,
  RUN_ID,
  seedPersistedRun,
  type Workspace,
} from '../__fixtures__/harness.js'
import { EXIT_OK } from '../result.js'
import { type DoctorData, doctorCommand } from './doctor.js'
import { missionStatusCommand } from './mission-status.js'
import { providersCommand } from './providers.js'

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

/**
 * Saude com `running` MENTIROSO: e exatamente o que o `CapacityLedger` de um processo
 * novo devolve — zero quando ha agentes em voo, ou um numero de outra vida.
 */
const STALE = health({
  providerId: 'mock',
  installed: true,
  ready: true,
  version: '1.0.0-mock',
  detail: 'agente in-process',
  capacity: 4,
  running: 7,
})

function dataOf(result: { readonly data?: unknown }): DoctorData {
  return result.data as DoctorData
}

function runningOf(result: { readonly data?: unknown }, provider = 'mock'): number | undefined {
  return dataOf(result).providers.find((entry) => entry.providerId === provider)?.running
}

describe('doctor: agentes em voo saem do estado persistido', () => {
  it('CONTROLE: sem run persistido o numero e ZERO, nao o 7 do processo', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    const captured = captureDeps({ cwd: workspace.dir, registry: () => fakeRegistry([STALE]) })
    const result = await doctorCommand({}, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(runningOf(result)).toBe(0)
    expect(dataOf(result).providerStates[0]?.running).toBe(0)
  })

  it('duas tentativas em voo no banco viram 2, mesmo lidas de outro processo', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    await seedPersistedRun(workspace.dir, [
      { taskId: 'T01', providerId: 'mock' },
      { taskId: 'T02', providerId: 'mock' },
    ])
    const captured = captureDeps({ cwd: workspace.dir, registry: () => fakeRegistry([STALE]) })
    const result = await doctorCommand({}, captured.deps)

    expect(runningOf(result)).toBe(2)
    expect(captured.stdout()).toContain('em voo         2')
  })

  it('o check `state.running` declara de onde o numero saiu', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    await seedPersistedRun(workspace.dir, [{ taskId: 'T01', providerId: 'mock' }])
    const captured = captureDeps({ cwd: workspace.dir, registry: () => fakeRegistry([STALE]) })
    const result = await doctorCommand({}, captured.deps)
    const check = dataOf(result).checks.find((item) => item.id === 'state.running')

    expect(check?.status).toBe('ok')
    expect(check?.detail).toContain('estado persistido')
    expect(dataOf(result).runningSource).toContain('estado persistido')
  })

  it('run terminal nao conta: agente encerrado nao ocupa vaga', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    await seedPersistedRun(workspace.dir, [{ taskId: 'T01', providerId: 'mock' }], {
      runStatus: 'COMPLETED',
    })
    const captured = captureDeps({ cwd: workspace.dir, registry: () => fakeRegistry([STALE]) })

    expect(runningOf(await doctorCommand({}, captured.deps))).toBe(0)
  })

  it('`providers` conta o mesmo que o doctor', async () => {
    workspace = await createWorkspace()
    await seedPersistedRun(workspace.dir, [{ taskId: 'T01', providerId: 'mock' }])
    const captured = captureDeps({ cwd: workspace.dir, registry: () => fakeRegistry([STALE]) })
    const result = await providersCommand({}, captured.deps)

    expect(captured.stdout()).toMatch(/mock\s+sim\s+sim\s+1\.0\.0-mock\s+1\s+4/)
    expect((result.data as { running: number }[])[0]?.running).toBe(1)
  })

  it('`mission status` mostra EM USO real — era o defeito observado (EM USO 0)', async () => {
    workspace = await createWorkspace()
    await seedPersistedRun(workspace.dir, [
      { taskId: 'T01', providerId: 'mock' },
      { taskId: 'T02', providerId: 'mock' },
    ])
    const captured = captureDeps({ cwd: workspace.dir, registry: () => fakeRegistry([STALE]) })
    const result = await missionStatusCommand({ runId: RUN_ID }, captured.deps)
    const row = captured
      .stdout()
      .split('\n')
      .find((line) => line.trim().startsWith('mock'))

    expect(result.exitCode).toBe(EXIT_OK)
    expect(row).toMatch(/mock\s+sim\s+sim\s+2\s+4/)
  })

  it('`mission status` com o run parado mostra zero, nao o numero velho', async () => {
    workspace = await createWorkspace()
    await seedPersistedRun(workspace.dir, [{ taskId: 'T01', providerId: 'mock' }], {
      runStatus: 'COMPLETED',
    })
    const captured = captureDeps({ cwd: workspace.dir, registry: () => fakeRegistry([STALE]) })
    await missionStatusCommand({ runId: RUN_ID }, captured.deps)
    const row = captured
      .stdout()
      .split('\n')
      .find((line) => line.trim().startsWith('mock'))

    expect(row).toMatch(/mock\s+sim\s+sim\s+0\s+4/)
  })
})
