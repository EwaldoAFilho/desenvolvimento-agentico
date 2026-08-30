import type { ControlPlane } from '@agentic/orchestrator'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureDeps,
  createWorkspace,
  fakePlane,
  RUN_ID,
  RUN_SNAPSHOT,
  type Workspace,
} from '../__fixtures__/harness.js'
import { noControlPlaneMessage } from '../plane.js'
import { EXIT_OK } from '../result.js'
import { missionApproveCommand } from './mission-approve.js'
import { missionStartCommand } from './mission-start.js'
import { pauseCommand, taskRetryCommand, taskSkipCommand } from './mutations.js'

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

async function refusalOf(
  command: (deps: ReturnType<typeof captureDeps>['deps']) => Promise<unknown>,
): Promise<{ code: string; message: string }> {
  workspace = await createWorkspace()
  const captured = captureDeps({ cwd: workspace.dir, connect: () => Promise.resolve(undefined) })
  try {
    await command(captured.deps)
  } catch (error) {
    const failure = error as { readonly code: string; readonly message: string }
    return { code: failure.code, message: failure.message }
  }
  throw new Error('esperava recusa por falta de control plane')
}

describe('recusa de mutacao sem control plane', () => {
  it('continua recusando: I7 nao admite escrita no banco por fora do orquestrador', async () => {
    const refusal = await refusalOf((deps) => pauseCommand({ runId: RUN_ID }, deps))

    expect(refusal.code).toBe('NO_CONTROL_PLANE')
    expect(refusal.message).toContain('I7')
  })

  it('explica o caso real: `mission start` sem --serve orquestra mas nao publica HTTP', async () => {
    const refusal = await refusalOf((deps) => pauseCommand({ runId: RUN_ID }, deps))

    expect(refusal.message).toContain('SEM `--serve`')
    expect(refusal.message).toContain('NAO publica HTTP')
    expect(refusal.message).toContain('inalcancaveis')
  })

  it('aponta o caminho de volta: `mission start --serve` e `agentic serve`', async () => {
    const refusal = await refusalOf((deps) => pauseCommand({ runId: RUN_ID }, deps))

    expect(refusal.message).toContain('agentic mission start <arquivo> --serve')
    expect(refusal.message).toContain('agentic serve')
  })

  it('a mensagem nomeia o endereco que foi tentado', () => {
    expect(noControlPlaneMessage('http://127.0.0.1:4317')).toContain('http://127.0.0.1:4317')
  })

  it('`task retry` recebe a mesma explicacao', async () => {
    const refusal = await refusalOf((deps) =>
      taskRetryCommand({ taskId: 'T01', runId: RUN_ID }, deps),
    )
    expect(refusal.message).toContain('--serve')
  })

  it('`task skip` recebe a mesma explicacao', async () => {
    const refusal = await refusalOf((deps) =>
      taskSkipCommand({ taskId: 'T01', runId: RUN_ID, reason: 'fora de escopo' }, deps),
    )
    expect(refusal.message).toContain('--serve')
  })
})

interface FakeRun {
  readonly id: string
  readonly missionId: string
  readonly status: string
  readonly specHash: string
}

function planeWithRun(run: FakeRun, extra: Partial<ControlPlane>): ControlPlane {
  return fakePlane({
    persistence: {
      queries: { listRuns: () => [{ id: run.id, mission_id: run.missionId }] },
      runs: { loadRun: () => Promise.resolve(run) },
    } as never,
    ...extra,
  })
}

async function approvedRun(dir: string, file: string): Promise<string> {
  const captured = captureDeps({ cwd: dir })
  const result = await missionApproveCommand({ file, actor: 'ewaldo' }, captured.deps)
  expect(result.exitCode).toBe(EXIT_OK)
  return (result.data as { readonly specHash: string }).specHash
}

function startPlane(specHash: string, drained: { value: boolean }): ControlPlane {
  return planeWithRun(
    { id: RUN_ID, missionId: 'TESTE-001', status: 'APPROVED', specHash },
    {
      startRun: () =>
        Promise.resolve({ id: RUN_ID, missionId: 'TESTE-001', status: 'RUNNING' } as never),
      open: () =>
        Promise.resolve({
          start: () => undefined,
          stop: () => undefined,
          drain: () => {
            drained.value = true
            return Promise.resolve()
          },
        } as never),
      getRunSnapshot: () => Promise.resolve(RUN_SNAPSHOT),
    },
  )
}

describe('mission start avisa sobre o modo sem HTTP', () => {
  it('sem --serve, diz ANTES que o run nao podera ser comandado', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const drained = { value: false }
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => startPlane(specHash, drained),
    })
    const result = await missionStartCommand(
      { file: workspace.missionPath, acceptWarnings: true },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(drained.value).toBe(true)
    expect(captured.stdout()).toContain('SEM API HTTP')
    expect(captured.stdout()).toContain('--serve')
  })

  it('com --serve, publica a API sobre o MESMO plane e diz o endereco', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const drained = { value: false }
    const plane = startPlane(specHash, drained)
    let received: unknown
    let closed = false
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => plane,
      servePlane: (input) => {
        received = input.plane
        return Promise.resolve({
          url: 'http://127.0.0.1:4317',
          close: () => {
            closed = true
            return Promise.resolve()
          },
        })
      },
    })
    const result = await missionStartCommand(
      { file: workspace.missionPath, acceptWarnings: true, serve: true },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    // MESMO plane: um segundo control plane seria um segundo escritor no banco (I7).
    expect(received).toBe(plane)
    expect(captured.stdout()).toContain('http://127.0.0.1:4317')
    expect(captured.stdout()).toContain('mission pause')
    expect(closed).toBe(true)
    expect(drained.value).toBe(false)
  })

  it('se a API nao subir, o run continua e o usuario e avisado', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const drained = { value: false }
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => startPlane(specHash, drained),
      servePlane: () => Promise.reject(new Error('EADDRINUSE')),
    })
    const result = await missionStartCommand(
      { file: workspace.missionPath, acceptWarnings: true, serve: true },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(captured.stderr()).toContain('EADDRINUSE')
    expect(captured.stdout()).toContain('SEM API HTTP')
  })
})
