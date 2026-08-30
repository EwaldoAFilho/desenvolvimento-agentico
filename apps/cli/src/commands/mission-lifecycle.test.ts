import type { ControlPlane } from '@agentic/orchestrator'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureDeps,
  createWorkspace,
  fakePlane,
  MISSION_WITH_ERROR,
  MISSION_WITH_WARNING,
  RUN_ID,
  RUN_SNAPSHOT,
  recordingLink,
  type Workspace,
} from '../__fixtures__/harness.js'
import { EXIT_ERROR, EXIT_OK } from '../result.js'
import { type ApproveData, missionApproveCommand } from './mission-approve.js'
import { missionStartCommand } from './mission-start.js'
import { missionValidateCommand } from './mission-validate.js'

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

async function specHashOf(dir: string, file: string): Promise<string> {
  const captured = captureDeps({ cwd: dir })
  const result = await missionValidateCommand({ file, json: true }, captured.deps)
  const report = result.data as { readonly specHash?: string }
  return report.specHash ?? ''
}

interface FakeRun {
  readonly id: string
  readonly missionId: string
  readonly status: string
  readonly specHash: string
}

/** Plane de mentira com UM run no banco: exercita a decisao da CLI, nao a do orquestrador. */
function planeWithRun(run: FakeRun, extra: Partial<ControlPlane>): ControlPlane {
  return fakePlane({
    persistence: {
      queries: { listRuns: () => [{ id: run.id, mission_id: run.missionId }] },
      runs: { loadRun: () => Promise.resolve(run) },
    } as never,
    ...extra,
  })
}

async function approve(dir: string, file: string, actor = 'ewaldo'): Promise<ApproveData> {
  const captured = captureDeps({ cwd: dir })
  const result = await missionApproveCommand({ file, actor }, captured.deps)
  expect(result.exitCode).toBe(EXIT_OK)
  return result.data as ApproveData
}

describe('mission approve', () => {
  it('cria o run e registra o ato humano com actor', async () => {
    workspace = await createWorkspace()
    const data = await approve(workspace.dir, workspace.missionPath)

    expect(data.status).toBe('APPROVED')
    expect(data.actor).toBe('ewaldo')
    expect(data.created).toBe(true)
    expect(data.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('sem --actor sai 2: nao existe aprovacao anonima', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    await expect(
      missionApproveCommand({ file: workspace.missionPath }, captured.deps),
    ).rejects.toMatchObject({ code: 'MISSING_ACTOR', usage: true })
  })

  it('recusa aprovar missao com ERROR', async () => {
    workspace = await createWorkspace({ mission: MISSION_WITH_ERROR })
    const captured = captureDeps({ cwd: workspace.dir })
    const result = await missionApproveCommand(
      { file: workspace.missionPath, actor: 'ewaldo' },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(result.error?.code).toBe('VALIDATION_FAILED')
  })

  it('reaproveita o run existente do mesmo specHash', async () => {
    workspace = await createWorkspace()
    const first = await approve(workspace.dir, workspace.missionPath)
    const captured = captureDeps({ cwd: workspace.dir })
    const again = await missionApproveCommand(
      { file: workspace.missionPath, actor: 'ewaldo' },
      captured.deps,
    )

    expect(again.exitCode).toBe(EXIT_OK)
    expect((again.data as ApproveData).runId).toBe(first.runId)
    expect(captured.stdout()).toContain('ja esta APPROVED')
  })

  it('com control plane no ar, entrega o ato humano por HTTP em vez de escrever no banco', async () => {
    workspace = await createWorkspace()
    const recorded = recordingLink()
    const captured = captureDeps({
      cwd: workspace.dir,
      connect: () => Promise.resolve(recorded.link),
      controlPlane: () => fakePlane({}),
    })
    const result = await missionApproveCommand(
      { file: workspace.missionPath, actor: 'ewaldo' },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(recorded.requests).toEqual([
      {
        method: 'POST',
        path: '/api/missions/TESTE-001/approve',
        body: { actor: 'ewaldo' },
      },
    ])
  })
})

describe('mission start', () => {
  it('recusa missao sem run aprovado', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    const result = await missionStartCommand({ file: workspace.missionPath }, captured.deps)

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(result.error?.code).toBe('NOT_APPROVED')
    expect(result.error?.message).toContain('agentic mission approve')
  })

  it('recusa missao com ERROR antes de olhar o run', async () => {
    workspace = await createWorkspace({ mission: MISSION_WITH_ERROR })
    const captured = captureDeps({ cwd: workspace.dir })
    const result = await missionStartCommand({ file: workspace.missionPath }, captured.deps)

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(result.error?.code).toBe('VALIDATION_FAILED')
    expect(captured.stdout()).toContain('DA1003')
  })

  it('com WARNING exige --accept-warnings', async () => {
    workspace = await createWorkspace({ mission: MISSION_WITH_WARNING })
    await approve(workspace.dir, workspace.missionPath)
    const captured = captureDeps({ cwd: workspace.dir })
    const result = await missionStartCommand({ file: workspace.missionPath }, captured.deps)

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(result.error?.code).toBe('WARNINGS_NOT_ACCEPTED')
    expect(result.error?.message).toContain('--accept-warnings')
  })

  it('recusa run que ja saiu de APPROVED', async () => {
    workspace = await createWorkspace()
    const dir = workspace.dir
    const file = workspace.missionPath
    const specHash = await specHashOf(dir, file)
    const captured = captureDeps({
      cwd: dir,
      controlPlane: () =>
        planeWithRun({ id: RUN_ID, missionId: 'TESTE-001', status: 'RUNNING', specHash }, {}),
    })
    const result = await missionStartCommand({ file }, captured.deps)

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(result.error?.code).toBe('NOT_APPROVED')
    expect(result.error?.message).toContain('RUNNING')
  })

  it('com run APPROVED, chama startRun e drena o orquestrador', async () => {
    workspace = await createWorkspace()
    const dir = workspace.dir
    const file = workspace.missionPath
    const specHash = await specHashOf(dir, file)
    let started: { readonly acceptWarnings: boolean } | undefined
    let drained = false
    const captured = captureDeps({
      cwd: dir,
      controlPlane: () =>
        planeWithRun(
          { id: RUN_ID, missionId: 'TESTE-001', status: 'APPROVED', specHash },
          {
            startRun: (input) => {
              started = input
              return Promise.resolve({
                id: RUN_ID,
                missionId: 'TESTE-001',
                status: 'RUNNING',
              } as never)
            },
            open: () =>
              Promise.resolve({
                start: () => undefined,
                stop: () => undefined,
                drain: () => {
                  drained = true
                  return Promise.resolve()
                },
              } as never),
            getRunSnapshot: () => Promise.resolve(RUN_SNAPSHOT),
          },
        ),
    })
    const result = await missionStartCommand({ file, acceptWarnings: true }, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(started?.acceptWarnings).toBe(true)
    expect(drained).toBe(true)
    expect(captured.stdout()).toContain('status final: RUNNING')
  })

  it('com control plane no ar, delega START MISSION por HTTP', async () => {
    workspace = await createWorkspace()
    const recorded = recordingLink()
    const captured = captureDeps({
      cwd: workspace.dir,
      connect: () => Promise.resolve(recorded.link),
      controlPlane: () => fakePlane({}),
    })
    const result = await missionStartCommand(
      { file: workspace.missionPath, acceptWarnings: true, actor: 'ewaldo' },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    const request = recorded.requests[0]
    expect(request?.path).toBe('/api/runs')
    expect(request?.body).toMatchObject({ acceptWarnings: true, actor: 'ewaldo' })
  })

  it('--serve mantem o control plane em primeiro plano em vez de drenar', async () => {
    workspace = await createWorkspace()
    const dir = workspace.dir
    const file = workspace.missionPath
    const specHash = await specHashOf(dir, file)
    let started = false
    let stopped = false
    let drained = false
    let waited = false
    const captured = captureDeps({
      cwd: dir,
      waitForShutdown: () => {
        waited = true
        return Promise.resolve()
      },
      controlPlane: () =>
        planeWithRun(
          { id: RUN_ID, missionId: 'TESTE-001', status: 'APPROVED', specHash },
          {
            startRun: () =>
              Promise.resolve({ id: RUN_ID, missionId: 'TESTE-001', status: 'RUNNING' } as never),
            open: () =>
              Promise.resolve({
                start: () => {
                  started = true
                },
                stop: () => {
                  stopped = true
                },
                drain: () => {
                  drained = true
                  return Promise.resolve()
                },
              } as never),
            getRunSnapshot: () => Promise.resolve(RUN_SNAPSHOT),
          },
        ),
    })
    const result = await missionStartCommand(
      { file, acceptWarnings: true, serve: true },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(started).toBe(true)
    expect(waited).toBe(true)
    expect(stopped).toBe(true)
    expect(drained).toBe(false)
    expect(captured.stdout()).toContain('Ctrl+C')
  })

  it('usa o usuario do ambiente quando --actor nao e informado', async () => {
    workspace = await createWorkspace()
    const recorded = recordingLink()
    const captured = captureDeps({
      cwd: workspace.dir,
      connect: () => Promise.resolve(recorded.link),
      controlPlane: () => fakePlane({}),
    })
    await missionStartCommand({ file: workspace.missionPath }, captured.deps)

    expect(recorded.requests[0]?.body).toMatchObject({ actor: 'teste' })
  })
})
