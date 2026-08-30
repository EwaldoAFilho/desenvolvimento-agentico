import type { ArtifactRow } from '@agentic/persistence'
import type { RunSnapshot, TaskDetail } from '@agentic/schemas'
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
import { agentLogsOf, type TaskInspectData, taskInspectCommand } from './task-inspect.js'
import { waitExplanationOf } from './task-waiting.js'

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

function artifact(kind: string, path: string): ArtifactRow {
  return {
    id: `${kind}-${path}`,
    run_id: RUN_ID,
    kind,
    path,
    digest: 'abc123',
    bytes: 4096,
    created_at: '2026-01-01T00:00:00.000Z',
  }
}

/** Plane de leitura com artefatos e, opcionalmente, snapshot para a razao de espera. */
function planeWithArtifacts(
  detail: TaskDetail,
  artifacts: readonly ArtifactRow[],
  snapshot?: RunSnapshot,
): ReturnType<typeof fakePlane> {
  return fakePlane({
    getTaskDetail: () => Promise.resolve(detail),
    ...(snapshot === undefined ? {} : { getRunSnapshot: () => Promise.resolve(snapshot) }),
    persistence: {
      queries: { listArtifacts: () => [...artifacts], listRuns: () => [] },
    } as never,
  })
}

async function inspect(
  plane: ReturnType<typeof fakePlane>,
  taskId = 'T05',
): Promise<{ data: TaskInspectData; text: string }> {
  workspace = await createWorkspace()
  const captured = captureDeps({ cwd: workspace.dir, controlPlane: () => plane })
  const result = await taskInspectCommand({ taskId, runId: RUN_ID }, captured.deps)
  return { data: result.data as TaskInspectData, text: captured.stdout() }
}

describe('agentLogsOf', () => {
  it('pega artefato de agente da tentativa desta task', () => {
    const rows = [
      artifact('agent-log', `runs/${RUN_ID}/attempts/T05-a1/agent.log`),
      artifact('patch', `runs/${RUN_ID}/attempts/T05-a1/patch.diff`),
      artifact('agent-log', `runs/${RUN_ID}/attempts/T09-a1/agent.log`),
    ]
    const found = agentLogsOf(rows, 'T05')

    expect(found).toHaveLength(1)
    expect(found[0]?.path).toContain('T05-a1/agent.log')
  })

  it('pega stdout e stderr do agente, e nao confunde com saida de gate', () => {
    const rows = [
      artifact('agent-stdout', `runs/${RUN_ID}/attempts/T05-a2/agent.out`),
      artifact('agent-stderr', `runs/${RUN_ID}/attempts/T05-a2/agent.err`),
      artifact('gate-stdout', `runs/${RUN_ID}/attempts/T05-a2/gate-unit-0.stdout`),
    ]
    expect(agentLogsOf(rows, 'T05').map((log) => log.kind)).toEqual([
      'agent-stdout',
      'agent-stderr',
    ])
  })

  it('pega tambem o log do REVISOR: reprovacao de revisao sem evidencia e o mesmo defeito', () => {
    const rows = [
      artifact('agent-log', `runs/${RUN_ID}/attempts/T05-a1/agent.log.jsonl`),
      artifact('review-log', `runs/${RUN_ID}/attempts/T05-a1/review.log.jsonl`),
      artifact('gate-stdout', `runs/${RUN_ID}/attempts/T05-a1/gate-unit-0.stdout`),
    ]
    expect(agentLogsOf(rows, 'T05').map((log) => log.kind)).toEqual(['agent-log', 'review-log'])
  })

  it('sem artefato de agente devolve lista vazia — nao inventa referencia', () => {
    expect(
      agentLogsOf([artifact('patch', `runs/${RUN_ID}/attempts/T05-a1/patch.diff`)], 'T05'),
    ).toHaveLength(0)
  })
})

describe('task inspect: referencia do log do agente', () => {
  it('imprime caminho, tamanho e digest quando o log existe', async () => {
    const { data, text } = await inspect(
      planeWithArtifacts(TASK_DETAIL, [
        artifact('agent-log', `runs/${RUN_ID}/attempts/T05-a1/agent.log`),
      ]),
    )

    expect(text).toContain('log do agente')
    expect(text).toContain('T05-a1/agent.log')
    expect(text).toContain('sha256:abc123')
    expect(data.agentLogs).toHaveLength(1)
  })

  it('DIZ que nao ha log persistido em vez de calar — foi o que custou o smoke real', async () => {
    const { data, text } = await inspect(planeWithArtifacts(TASK_DETAIL, []))

    expect(text).toContain('nenhum log de agente persistido')
    expect(data.agentLogs).toEqual([])
  })

  it('`--json` continua carregando todo campo de TaskDetail e acrescenta agentLogs', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => planeWithArtifacts(TASK_DETAIL, []),
    })
    const result = await taskInspectCommand(
      { taskId: 'T05', runId: RUN_ID, json: true },
      captured.deps,
    )
    const data = result.data as TaskInspectData

    expect(captured.stdout()).toBe('')
    expect(data.isolation).toEqual(TASK_DETAIL.isolation)
    expect(data.attempts).toEqual(TASK_DETAIL.attempts)
    expect(data.agentLogs).toEqual([])
  })
})

const PENDING: TaskDetail = {
  ...TASK_DETAIL,
  id: 'T02' as TaskDetail['id'],
  status: 'PENDING',
  scope: { ...TASK_DETAIL.scope, touches: ['src/fim/'] },
  graph: {
    ...TASK_DETAIL.graph,
    dependencies: [{ id: 'T01' as TaskDetail['id'], status: 'RUNNING' }],
  },
}

describe('razao de espera', () => {
  it('dependencia nao concluida e o motivo, com quem esta na frente', () => {
    const wait = waitExplanationOf(PENDING, RUN_SNAPSHOT)
    expect(wait?.reason).toBe('DEPENDENCIES')
    expect(wait?.blockedBy).toEqual(['T01:RUNNING'])
  })

  it('run PAUSED e o motivo quando as dependencias ja fecharam', () => {
    const detail = {
      ...PENDING,
      graph: {
        ...PENDING.graph,
        dependencies: [{ id: 'T01' as TaskDetail['id'], status: 'DONE' as const }],
      },
    }
    const snapshot: RunSnapshot = {
      ...RUN_SNAPSHOT,
      run: { ...RUN_SNAPSHOT.run, status: 'PAUSED' },
    }
    const wait = waitExplanationOf(detail, snapshot)

    expect(wait?.reason).toBe('RUN_PAUSED')
    expect(wait?.detail).toContain('mission resume')
  })

  it('touches sobrepostos com task em voo sao SCOPE_LOCK (I2)', () => {
    const detail = {
      ...PENDING,
      scope: { ...PENDING.scope, touches: ['src/fim/'] },
      graph: {
        ...PENDING.graph,
        dependencies: [{ id: 'T01' as TaskDetail['id'], status: 'DONE' as const }],
      },
    }
    // T02 esta RUNNING no snapshot e declara `src/fim/`.
    const wait = waitExplanationOf(detail, RUN_SNAPSHOT)

    expect(wait?.reason).toBe('SCOPE_LOCK')
    expect(wait?.blockedBy).toContain('T02')
  })

  it('teto global atingido, sem sobreposicao de escopo, e GLOBAL_LIMIT', () => {
    const detail = {
      ...PENDING,
      scope: { ...PENDING.scope, touches: ['src/outro/'] },
      graph: { ...PENDING.graph, dependencies: [] },
    }
    const snapshot: RunSnapshot = {
      ...RUN_SNAPSHOT,
      run: { ...RUN_SNAPSHOT.run, policies: { ...RUN_SNAPSHOT.run.policies, maxParallelTasks: 1 } },
    }
    const wait = waitExplanationOf(detail, snapshot)

    expect(wait?.reason).toBe('GLOBAL_LIMIT')
  })

  it('fornecedor no teto e PROVIDER_CAPACITY', () => {
    const detail = {
      ...PENDING,
      scope: { ...PENDING.scope, touches: ['src/outro/'] },
      graph: { ...PENDING.graph, dependencies: [] },
    }
    const snapshot: RunSnapshot = {
      ...RUN_SNAPSHOT,
      providers: RUN_SNAPSHOT.providers.map((provider) => ({
        ...provider,
        running: 4,
        capacity: 4,
      })),
    }
    const wait = waitExplanationOf(detail, snapshot)

    expect(wait?.reason).toBe('PROVIDER_CAPACITY')
    expect(wait?.blockedBy[0]).toContain('4/4')
  })

  it('CONTROLE: nada segurando a task devolve NEXT_TICK, nao um motivo inventado', () => {
    const detail = {
      ...PENDING,
      scope: { ...PENDING.scope, touches: ['src/outro/'] },
      graph: { ...PENDING.graph, dependencies: [] },
    }
    expect(waitExplanationOf(detail, RUN_SNAPSHOT)?.reason).toBe('NEXT_TICK')
  })

  it('task que nao esta esperando nao ganha explicacao nenhuma', () => {
    expect(waitExplanationOf(TASK_DETAIL, RUN_SNAPSHOT)).toBeUndefined()
  })

  it('o comando imprime a secao de espera para uma task PENDING', async () => {
    const { data, text } = await inspect(planeWithArtifacts(PENDING, [], RUN_SNAPSHOT), 'T02')

    expect(text).toContain('espera')
    expect(text).toContain('motivo        DEPENDENCIES')
    expect(data.waiting?.reason).toBe('DEPENDENCIES')
  })

  it('task em REVIEW nao paga o custo de ler o snapshot', async () => {
    // `fakePlane` sem `getRunSnapshot` lanca se alguem o chamar: a ausencia e a asserção.
    const { data } = await inspect(planeWithArtifacts(TASK_DETAIL, []))
    expect(data.waiting).toBeUndefined()
  })
})
