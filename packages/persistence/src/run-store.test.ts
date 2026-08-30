import { attemptId, gateId, pathScope, taskRunId } from '@agentic/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  attempt,
  blockage,
  closedAttempt,
  gateExecution,
  LATER,
  MISSION,
  NOW,
  RUN,
  RUN_B,
  review,
  run,
  seededRun,
  T01,
  T02,
  type TempPersistence,
  taskRun,
  tempPersistence,
} from './__fixtures__/builders.js'

let temp: TempPersistence

beforeEach(async () => {
  temp = await tempPersistence()
})

afterEach(async () => {
  await temp.dispose()
})

describe('createRun', () => {
  it('grava run e task_runs', async () => {
    const { runs } = temp.persistence
    await seededRun(temp.persistence)

    const stored = await runs.loadRun(RUN)
    expect(stored?.id).toBe(RUN)
    const taskRuns = await runs.loadTaskRuns(RUN)
    expect(taskRuns.map((t) => t.taskId)).toEqual([T01, T02])
  })

  it('emite run.created e um task.created por task na mesma transacao', async () => {
    const { runs, events } = temp.persistence
    await seededRun(temp.persistence)

    const stream = await events.list(RUN)
    expect(stream.map((e) => e.type)).toEqual(['run.created', 'task.created', 'task.created'])
    const created = stream[0]
    expect(created?.payload).toEqual({ missionId: MISSION, specHash: 'sha256:spec-hash' })
    expect(await runs.loadRun(RUN)).toBeDefined()
  })

  it('task.created carrega as dependencias do grafo congelado', async () => {
    const { events } = temp.persistence
    await seededRun(temp.persistence)

    const stream = await events.list(RUN, { types: ['task.created'] })
    const second = stream.find((e) => e.taskId === T02)
    expect(second?.payload).toEqual({ dependencies: [T01] })
  })

  it('run inexistente devolve undefined', async () => {
    const { runs } = temp.persistence
    expect(await runs.loadRun(RUN)).toBeUndefined()
  })
})

describe('round-trip', () => {
  it('Run preserva todos os campos, incluindo policies e graph', async () => {
    const { runs } = temp.persistence
    const source = run({
      status: 'FAILED',
      finishedAt: LATER,
      missionGateId: gateId('core'),
      missionGateExecutionId: 'gx-mission',
      integrationBranch: 'agentic/DA-CORE-001',
      failureReason: 'gate de missao reprovou',
    })
    await seededRun(temp.persistence, source)

    const stored = await runs.loadRun(RUN)
    expect(stored).toEqual(source)
    expect(stored?.policies.denyPaths).toEqual(['.agentic/', 'node_modules/'])
    expect(stored?.graph.tasks[0]?.touches).toEqual([pathScope('packages/persistence/')])
    expect(stored?.createdAt.getTime()).toBe(NOW.getTime())
  })

  it('TaskRun preserva blockage e outcome', async () => {
    const { runs } = temp.persistence
    await seededRun(temp.persistence)
    const source = taskRun({
      status: 'BLOCKED',
      attemptCount: 2,
      currentAttemptId: attempt().id,
      unblockedBy: [T02],
      readyAt: NOW,
      startedAt: NOW,
      finishedAt: LATER,
      blockage: blockage(),
      outcome: { kind: 'FAILED', reason: 'sem caminho', failureCode: 'POLICY_VIOLATION' },
    })

    await runs.withTransaction(async (uow) => {
      await uow.saveAttempt(attempt())
      await uow.saveTaskRun(source)
      await uow.appendEvent({
        runId: RUN,
        ts: NOW,
        type: 'task.blocked',
        actor: { kind: 'orchestrator' },
        taskId: T01,
        payload: { blockage: blockage() },
      })
    })

    const stored = (await runs.loadTaskRuns(RUN)).find((t) => t.taskId === T01)
    expect(stored).toEqual(source)
    expect(stored?.blockage?.raisedAt).toBeInstanceOf(Date)
    expect(stored?.blockage?.raisedAt?.getTime()).toBe(NOW.getTime())
    expect(stored?.blockage?.resolvedAt?.getTime()).toBe(LATER.getTime())
  })

  it('Attempt preserva claims, observation, usage e failureReason', async () => {
    const { runs } = temp.persistence
    await seededRun(temp.persistence)
    const source = closedAttempt()

    await runs.withTransaction(async (uow) => {
      await uow.saveAttempt(source)
      await uow.appendEvent({
        runId: RUN,
        ts: NOW,
        type: 'attempt.finished',
        actor: { kind: 'orchestrator' },
        taskId: T01,
        payload: { result: 'FAIL', durationMs: 876_333 },
      })
    })

    const [stored] = await runs.loadAttempts(RUN, T01)
    expect(stored).toEqual(source)
    expect(stored?.claims?.reportedFiles).toEqual(['packages/persistence/src/index.ts'])
    expect(stored?.observation?.outOfScopePaths).toEqual(['packages/domain/src/run.ts'])
    expect(stored?.observation?.filesChanged[1]?.renamedFrom).toBe(
      'packages/persistence/src/store.ts',
    )
    expect(stored?.usage).toEqual({
      model: 'model-x',
      inputTokens: 1234,
      outputTokens: 567,
      costUsd: 0.42,
    })
    expect(stored?.failureReason).toEqual({
      code: 'SCOPE_VIOLATION',
      detail: 'escreveu fora de touches',
    })
  })

  it('AgentIdentity volta com Date, nao com string', async () => {
    const { runs } = temp.persistence
    await seededRun(temp.persistence)

    await runs.withTransaction(async (uow) => {
      await uow.saveAttempt(attempt())
      await uow.appendEvent({
        runId: RUN,
        ts: NOW,
        type: 'attempt.started',
        actor: { kind: 'orchestrator' },
        taskId: T01,
        payload: { attemptNumber: 1, workspace: attempt().workspace },
      })
    })

    const [stored] = await runs.loadAttempts(RUN)
    expect(stored?.executor.startedAt).toBeInstanceOf(Date)
    expect(stored?.executor.runtime?.startedAt).toBeInstanceOf(Date)
    expect(stored?.executor.runtime?.pid).toBe(4242)
  })

  it('Review e GateExecution voltam junto da tentativa', async () => {
    const { runs } = temp.persistence
    await seededRun(temp.persistence)
    const source = closedAttempt({ gateExecutions: [gateExecution()], review: review() })

    await runs.withTransaction(async (uow) => {
      await uow.saveAttempt(source)
      await uow.appendEvent({
        runId: RUN,
        ts: NOW,
        type: 'review.finished',
        actor: { kind: 'orchestrator' },
        taskId: T01,
        payload: { verdict: 'PASS', findings: 2 },
      })
    })

    const [stored] = await runs.loadAttempts(RUN, T01)
    expect(stored?.gateExecutions).toEqual([gateExecution()])
    expect(stored?.review).toEqual(review())
    expect(stored?.review?.input.gateIds).toEqual([gateExecution().gateId])
    expect(stored?.review?.findings[1]?.evidenceRef?.digest).toBe('sha256:abc')
    expect(stored?.gateExecutions[0]?.results[1]?.exitCode).toBe(1)
  })

  it('GateExecution de missao (sem attempt) tambem faz round-trip', async () => {
    const { runs } = temp.persistence
    await seededRun(temp.persistence)
    const source = gateExecution({
      id: 'gx-mission',
      scope: 'mission',
      attemptId: undefined,
      status: 'FAIL',
      finishedAt: undefined,
    })

    await runs.withTransaction(async (uow) => {
      await uow.saveGateExecution(source)
      await uow.appendEvent({
        runId: RUN,
        ts: NOW,
        type: 'gate.finished',
        actor: { kind: 'orchestrator' },
        payload: { gateExecutionId: 'gx-mission', status: 'FAIL' },
      })
    })

    const row = temp.persistence.queries.getTaskDetailData(RUN, T01)
    expect(row.gateExecutions).toEqual([])
    const stored = temp.persistence.database.db
      .prepare('SELECT * FROM gate_executions WHERE id = ?')
      .get('gx-mission') as { scope: string; attempt_id: string | null; finished_at: string | null }
    expect(stored.scope).toBe('mission')
    expect(stored.attempt_id).toBeNull()
    expect(stored.finished_at).toBeNull()
  })

  it('loadAttempts filtra por task', async () => {
    const { runs } = temp.persistence
    await seededRun(temp.persistence)

    await runs.withTransaction(async (uow) => {
      await uow.saveAttempt(attempt())
      await uow.saveAttempt(
        attempt({ id: attemptId('att-2'), taskRunId: taskRunId(RUN, T02), attemptNumber: 1 }),
      )
      await uow.appendEvent({
        runId: RUN,
        ts: NOW,
        type: 'task.dispatched',
        actor: { kind: 'orchestrator' },
        payload: { executor: attempt().executor, dispatchReason: attempt().dispatchReason },
      })
    })

    expect(await runs.loadAttempts(RUN)).toHaveLength(2)
    expect(await runs.loadAttempts(RUN, T02)).toHaveLength(1)
    expect((await runs.loadAttempts(RUN, T02))[0]?.id).toBe('att-2')
    expect(await runs.loadAttempt(attemptId('att-2'))).toBeDefined()
  })
})

describe('listRuns', () => {
  it('lista do mais recente para o mais antigo', async () => {
    const { runs } = temp.persistence
    await seededRun(temp.persistence)
    await seededRun(
      temp.persistence,
      run({ id: RUN_B, status: 'COMPLETED', createdAt: LATER, finishedAt: LATER }),
    )

    const list = await runs.listRuns()
    expect(list.map((r) => r.id)).toEqual([RUN_B, RUN])
    expect(list[0]?.finishedAt?.getTime()).toBe(LATER.getTime())
    expect(list[1]?.finishedAt).toBeUndefined()
  })

  it('filtra por status, missao e limite', async () => {
    const { runs } = temp.persistence
    await seededRun(temp.persistence)
    await seededRun(temp.persistence, run({ id: RUN_B, status: 'COMPLETED', createdAt: LATER }))

    expect((await runs.listRuns({ status: ['COMPLETED'] })).map((r) => r.id)).toEqual([RUN_B])
    expect(await runs.listRuns({ missionId: MISSION })).toHaveLength(2)
    expect(await runs.listRuns({ limit: 1 })).toHaveLength(1)
    expect(await runs.listRuns({ status: ['CANCELLED'] })).toEqual([])
  })
})

describe('locks', () => {
  it('registra e libera lock de caminho', async () => {
    const { runs } = temp.persistence
    await seededRun(temp.persistence)
    const scope = pathScope('packages/persistence/')

    await runs.withTransaction(async (uow) => {
      await uow.saveAttempt(attempt())
      await uow.acquireLock(RUN, scope, attempt().id, NOW)
      await uow.appendEvent({
        runId: RUN,
        ts: NOW,
        type: 'workspace.acquired',
        actor: { kind: 'orchestrator' },
        taskId: T01,
        payload: { workspace: attempt().workspace },
      })
    })

    const held = await runs.listLocks(RUN)
    expect(held).toHaveLength(1)
    expect(held[0]?.path_prefix).toBe(scope)
    expect(held[0]?.attempt_id).toBe(attempt().id)

    await runs.withTransaction(async (uow) => {
      await uow.releaseLock(RUN, scope)
      await uow.appendEvent({
        runId: RUN,
        ts: LATER,
        type: 'workspace.released',
        actor: { kind: 'orchestrator' },
        taskId: T01,
        payload: { disposition: 'discard' },
      })
    })

    expect(await runs.listLocks(RUN)).toEqual([])
  })
})
