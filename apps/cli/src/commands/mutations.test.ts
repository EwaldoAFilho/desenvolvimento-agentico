import { afterEach, describe, expect, it } from 'vitest'
import {
  captureDeps,
  createWorkspace,
  RUN_ID,
  recordingLink,
  type Workspace,
} from '../__fixtures__/harness.js'
import { execute } from '../program.js'
import { EXIT_ERROR, EXIT_OK } from '../result.js'
import {
  type MutationData,
  pauseCommand,
  resumeCommand,
  stopCommand,
  taskRetryCommand,
  taskSkipCommand,
  taskUnblockCommand,
} from './mutations.js'

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

describe('unblock', () => {
  it('sem --note sai 2 com mensagem clara', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    await expect(
      taskUnblockCommand({ taskId: 'T01', runId: RUN_ID }, captured.deps),
    ).rejects.toMatchObject({ code: 'MISSING_NOTE', usage: true })
  })

  it('com --note entrega o comando ao control plane', async () => {
    workspace = await createWorkspace()
    const recorded = recordingLink()
    const captured = captureDeps({
      cwd: workspace.dir,
      connect: () => Promise.resolve(recorded.link),
    })
    const result = await taskUnblockCommand(
      { taskId: 'T01', runId: RUN_ID, note: 'dependencia externa resolvida', actor: 'ewaldo' },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(recorded.requests).toEqual([
      {
        method: 'POST',
        path: `/api/runs/${RUN_ID}/tasks/T01/unblock`,
        body: { taskId: 'T01', actor: 'ewaldo', note: 'dependencia externa resolvida' },
      },
    ])
    expect((result.data as MutationData).deliveredTo).toBe('http://127.0.0.1:4317')
  })

  it('nota so com espacos e recusada', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    await expect(
      taskUnblockCommand({ taskId: 'T01', runId: RUN_ID, note: '   ' }, captured.deps),
    ).rejects.toMatchObject({ code: 'MISSING_NOTE' })
  })
})

describe('skip', () => {
  it('sem --reason sai 2 com mensagem clara', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    await expect(
      taskSkipCommand({ taskId: 'T02', runId: RUN_ID }, captured.deps),
    ).rejects.toMatchObject({ code: 'MISSING_REASON', usage: true })
  })

  it('com --reason entrega o comando com o motivo registrado', async () => {
    workspace = await createWorkspace()
    const recorded = recordingLink()
    const captured = captureDeps({
      cwd: workspace.dir,
      connect: () => Promise.resolve(recorded.link),
    })
    const result = await taskSkipCommand(
      { taskId: 'T02', runId: RUN_ID, reason: 'entrega saiu do escopo' },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(recorded.requests[0]?.body).toMatchObject({ reason: 'entrega saiu do escopo' })
  })
})

describe('retry', () => {
  it('dispensa motivo e entrega o comando', async () => {
    workspace = await createWorkspace()
    const recorded = recordingLink()
    const captured = captureDeps({
      cwd: workspace.dir,
      connect: () => Promise.resolve(recorded.link),
    })
    const result = await taskRetryCommand({ taskId: 'T01', runId: RUN_ID }, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(recorded.requests[0]?.path).toBe(`/api/runs/${RUN_ID}/tasks/T01/retry`)
  })

  it('taskId fora do padrao e erro de uso', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    await expect(
      taskRetryCommand({ taskId: 'tarefa-1', runId: RUN_ID }, captured.deps),
    ).rejects.toMatchObject({ code: 'INVALID_TASK_ID', usage: true })
  })
})

describe('sem control plane no ar', () => {
  it('a CLI recusa em vez de escrever no banco por fora (I7)', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })

    await expect(
      taskUnblockCommand({ taskId: 'T01', runId: RUN_ID, note: 'segue o jogo' }, captured.deps),
    ).rejects.toMatchObject({ code: 'NO_CONTROL_PLANE' })
    await expect(pauseCommand({ runId: RUN_ID }, captured.deps)).rejects.toThrow(
      /nao escreve no banco por fora/,
    )
  })

  it('a recusa vira exit 1 no runner do programa', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    const result = await execute(captured.deps, 'mission pause', false, () =>
      pauseCommand({ runId: RUN_ID }, captured.deps),
    )

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(result.error?.code).toBe('NO_CONTROL_PLANE')
    expect(captured.stderr()).toContain('NO_CONTROL_PLANE')
  })
})

describe('comandos de run', () => {
  it('pause, resume e stop usam as rotas do control plane', async () => {
    workspace = await createWorkspace()
    const recorded = recordingLink()
    const captured = captureDeps({
      cwd: workspace.dir,
      connect: () => Promise.resolve(recorded.link),
    })

    await pauseCommand({ runId: RUN_ID, actor: 'ewaldo' }, captured.deps)
    await resumeCommand({ runId: RUN_ID, actor: 'ewaldo' }, captured.deps)
    const stopped = await stopCommand(
      { runId: RUN_ID, actor: 'ewaldo', reason: 'fim do dia' },
      captured.deps,
    )

    expect(stopped.exitCode).toBe(EXIT_OK)
    expect(recorded.requests.map((request) => request.path)).toEqual([
      `/api/runs/${RUN_ID}/pause`,
      `/api/runs/${RUN_ID}/resume`,
      `/api/runs/${RUN_ID}/stop`,
    ])
    expect(recorded.requests[2]?.body).toMatchObject({ reason: 'fim do dia' })
  })

  it('runId invalido e erro de uso antes de qualquer I/O', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    await expect(pauseCommand({ runId: 'run-1' }, captured.deps)).rejects.toMatchObject({
      code: 'INVALID_RUN_ID',
      usage: true,
    })
  })

  it('erro devolvido pelo control plane vira exit 1 com a mensagem dele', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      connect: () =>
        Promise.resolve({
          endpoint: 'http://127.0.0.1:4317',
          send: () => Promise.reject(new Error('run ja encerrado')),
        }),
    })
    const result = await execute(captured.deps, 'mission pause', false, () =>
      pauseCommand({ runId: RUN_ID }, captured.deps),
    )

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(result.error?.message).toBe('run ja encerrado')
  })
})
