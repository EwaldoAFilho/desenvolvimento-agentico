import type { RunId, TaskId } from '@agentic/domain'
import type { MissionReport } from '@agentic/orchestrator'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureDeps,
  createWorkspace,
  fakePlane,
  RUN_ID,
  RUN_SNAPSHOT,
  TASK_DETAIL,
  type Workspace,
} from '../__fixtures__/harness.js'
import { EXIT_OK } from '../result.js'
import { eventsTailCommand } from './events-tail.js'
import { missionStatusCommand } from './mission-status.js'
import { runReportCommand } from './run-report.js'
import { taskInspectCommand } from './task-inspect.js'

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

const REPORT: MissionReport = {
  runId: RUN_ID as RunId,
  missionId: 'TESTE-001' as MissionReport['missionId'],
  status: 'COMPLETED',
  tasks: { total: 2, done: 2, skipped: 0, cancelled: 0, blocked: 0 },
  attempts: 2,
  retries: 0,
  reviewFailures: 0,
  missionGate: { gateId: 'mission', status: 'PASS' },
  wallTimeMs: 65_000,
  criticalPath: { tasks: ['T01' as TaskId, 'T02' as TaskId], durationMs: 60_000 },
  slowestTasks: [{ taskId: 'T01' as TaskId, title: 'primeira task', durationMs: 40_000 }],
  retriedTasks: [],
  blockages: [],
  evidence: [
    {
      scope: 'task',
      taskId: 'T01' as TaskId,
      gateId: 'unit',
      status: 'PASS',
      command: 'npm run test',
      cwd: '/tmp/worktree',
      exitCode: 0,
      line: 'npm run test (exit 0)',
    },
  ],
}

describe('mission status', () => {
  it('imprime cabecalho, tasks, waves e providers', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => fakePlane({ getRunSnapshot: () => Promise.resolve(RUN_SNAPSHOT) }),
    })
    const result = await missionStatusCommand({ runId: RUN_ID }, captured.deps)
    const text = captured.stdout()

    expect(result.exitCode).toBe(EXIT_OK)
    expect(text).toContain(`run ${RUN_ID} · TESTE-001 · RUNNING`)
    expect(text).toContain('T01   DONE')
    expect(text).toContain('waves: T01 -> T02')
    expect(text).toContain('caminho critico: T01 -> T02')
    expect(text).toContain('mock')
  })

  it('--json devolve o RunSnapshot inteiro', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => fakePlane({ getRunSnapshot: () => Promise.resolve(RUN_SNAPSHOT) }),
    })
    const result = await missionStatusCommand({ runId: RUN_ID, json: true }, captured.deps)

    expect(captured.stdout()).toBe('')
    expect(result.data).toBe(RUN_SNAPSHOT)
  })

  it('sem run no banco, diz o que fazer', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => fakePlane({ persistence: { queries: { listRuns: () => [] } } as never }),
    })
    await expect(missionStatusCommand({}, captured.deps)).rejects.toThrow(/mission start/)
  })
})

describe('task inspect', () => {
  it('expoe worktree e branch da tentativa', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => fakePlane({ getTaskDetail: () => Promise.resolve(TASK_DETAIL) }),
    })
    const result = await taskInspectCommand({ taskId: 'T05', runId: RUN_ID }, captured.deps)
    const text = captured.stdout()

    expect(result.exitCode).toBe(EXIT_OK)
    expect(text).toContain('/tmp/projeto/.agentic/worktrees/RUN/T05-a1')
    expect(text).toContain('task/TESTE-001/T05/a1')
    expect(text).toContain('code /tmp/projeto/.agentic/worktrees/RUN/T05-a1')
  })

  it('mostra grafo, escopo, execucao, revisao, qualidade e fatos', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => fakePlane({ getTaskDetail: () => Promise.resolve(TASK_DETAIL) }),
    })
    await taskInspectCommand({ taskId: 'T05', runId: RUN_ID }, captured.deps)
    const text = captured.stdout()

    for (const group of [
      'grafo',
      'escopo',
      'execucao',
      'revisao',
      'isolamento',
      'qualidade',
      'fatos',
    ]) {
      expect(text).toContain(group)
    }
    expect(text).toContain('T03:DONE')
    expect(text).toContain('packages/compiler/')
  })

  it('--json devolve o TaskDetail com o caminho da worktree', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => fakePlane({ getTaskDetail: () => Promise.resolve(TASK_DETAIL) }),
    })
    const result = await taskInspectCommand(
      { taskId: 'T05', runId: RUN_ID, json: true },
      captured.deps,
    )

    expect(captured.stdout()).toBe('')
    expect(result.data).toMatchObject({
      isolation: {
        worktreePath: TASK_DETAIL.isolation.worktreePath,
        branch: TASK_DETAIL.isolation.branch,
      },
    })
  })

  it('taskId invalido nao chega ao control plane', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => fakePlane({}),
    })
    await expect(
      taskInspectCommand({ taskId: 'x1', runId: RUN_ID }, captured.deps),
    ).rejects.toMatchObject({ code: 'INVALID_TASK_ID' })
  })
})

describe('events tail', () => {
  it('lista eventos com seq, tipo e ator', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () =>
        fakePlane({
          persistence: {
            events: {
              list: () =>
                Promise.resolve([
                  {
                    seq: 7,
                    ts: new Date('2026-01-01T00:00:00.000Z'),
                    type: 'run.started',
                    actor: { kind: 'human', id: 'ewaldo' },
                    payload: {},
                  },
                ]),
            },
          } as never,
        }),
    })
    const result = await eventsTailCommand({ runId: RUN_ID }, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(captured.stdout()).toContain('run.started')
    expect(captured.stdout()).toContain('[human:ewaldo]')
    expect(result.data).toEqual([
      {
        seq: 7,
        ts: '2026-01-01T00:00:00.000Z',
        type: 'run.started',
        actor: { kind: 'human', id: 'ewaldo' },
        taskId: undefined,
        attemptId: undefined,
        payload: {},
      },
    ])
  })

  it('--since e repassado como afterSeq exclusivo', async () => {
    workspace = await createWorkspace()
    let query: { readonly afterSeq?: number } | undefined
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () =>
        fakePlane({
          persistence: {
            events: {
              list: (_runId: string, input: { readonly afterSeq?: number }) => {
                query = input
                return Promise.resolve([])
              },
            },
          } as never,
        }),
    })
    await eventsTailCommand({ runId: RUN_ID, since: 12 }, captured.deps)

    expect(query).toEqual({ afterSeq: 12 })
    expect(captured.stdout()).toContain('(nenhum evento)')
  })
})

describe('run report', () => {
  it('imprime metricas, caminho critico real e evidencia citavel', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => fakePlane({ generateMissionReport: () => Promise.resolve(REPORT) }),
    })
    const result = await runReportCommand({ runId: RUN_ID }, captured.deps)
    const text = captured.stdout()

    expect(result.exitCode).toBe(EXIT_OK)
    expect(text).toContain('tasks: 2/2 DONE')
    expect(text).toContain('mission gate: mission PASS')
    expect(text).toContain('npm run test')
    expect(text).toContain('exit 0')
  })

  it('--md usa o renderizador do relatorio', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => fakePlane({ generateMissionReport: () => Promise.resolve(REPORT) }),
    })
    await runReportCommand({ runId: RUN_ID, md: true }, captured.deps)

    expect(captured.stdout()).toContain('# Relatorio da missao TESTE-001')
    expect(captured.stdout()).toContain('## Evidencia citavel')
  })

  it('--json devolve o MissionReport', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => fakePlane({ generateMissionReport: () => Promise.resolve(REPORT) }),
    })
    const result = await runReportCommand({ runId: RUN_ID, json: true }, captured.deps)

    expect(captured.stdout()).toBe('')
    expect(result.data).toBe(REPORT)
  })
})
