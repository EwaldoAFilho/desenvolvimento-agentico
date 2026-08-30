import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  attempt,
  closedAttempt,
  gateExecution,
  MISSING_RUN,
  RUN,
  run,
  seededRun,
  T01,
  type TempPersistence,
  taskRun,
  tempPersistence,
} from './__fixtures__/builders.js'
import type { SqliteDatabase } from './driver.js'
import { StateWithoutEventError } from './errors.js'

let temp: TempPersistence

function count(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total
}

beforeEach(async () => {
  temp = await tempPersistence()
})

afterEach(async () => {
  await temp.dispose()
})

describe('I1 — estado e evento na mesma transacao', () => {
  it('excecao no meio do work nao deixa nem estado nem evento', async () => {
    const { runs, database } = temp.persistence
    await seededRun(temp.persistence)

    const stateBefore = count(database.db, 'task_runs')
    const attemptsBefore = count(database.db, 'attempts')
    const eventsBefore = count(database.db, 'events')

    await expect(
      runs.withTransaction(async (uow) => {
        await uow.saveTaskRun(taskRun({ status: 'RUNNING', attemptCount: 1 }))
        await uow.saveAttempt(attempt())
        await uow.appendEvent({
          runId: RUN,
          ts: new Date(),
          type: 'task.dispatched',
          actor: { kind: 'orchestrator' },
          taskId: T01,
          payload: {
            executor: attempt().executor,
            dispatchReason: attempt().dispatchReason,
          },
        })
        throw new Error('agente morreu no meio')
      }),
    ).rejects.toThrow('agente morreu no meio')

    expect(count(database.db, 'task_runs')).toBe(stateBefore)
    expect(count(database.db, 'attempts')).toBe(attemptsBefore)
    expect(count(database.db, 'events')).toBe(eventsBefore)
  })

  it('falha do banco no meio do commit reverte estado E evento', async () => {
    const { runs, database } = temp.persistence
    await seededRun(temp.persistence)

    const taskRunsBefore = count(database.db, 'task_runs')
    const eventsBefore = count(database.db, 'events')
    const gatesBefore = count(database.db, 'gate_executions')
    // O upsert nao muda a contagem de linhas: e o VALOR que precisa voltar ao anterior.
    const statusBefore = (await runs.loadTaskRuns(RUN)).find((t) => t.taskId === T01)?.status

    await expect(
      runs.withTransaction(async (uow) => {
        await uow.saveTaskRun(taskRun({ status: 'VERIFYING' }))
        await uow.appendEvent({
          runId: RUN,
          ts: new Date(),
          type: 'task.verifying',
          actor: { kind: 'orchestrator' },
          taskId: T01,
          payload: { attemptId: attempt().id },
        })
        // Chave estrangeira invalida: o run 'inexistente' nao existe.
        await uow.saveGateExecution(gateExecution({ runId: MISSING_RUN, attemptId: undefined }))
      }),
    ).rejects.toThrow()

    expect(count(database.db, 'task_runs')).toBe(taskRunsBefore)
    expect(count(database.db, 'events')).toBe(eventsBefore)
    expect(count(database.db, 'gate_executions')).toBe(gatesBefore)
    expect(statusBefore).toBe('PENDING')
    expect((await runs.loadTaskRuns(RUN)).find((t) => t.taskId === T01)?.status).toBe(statusBefore)
  })

  it('estado sem evento e recusado antes de tocar o banco', async () => {
    const { runs, database } = temp.persistence
    await seededRun(temp.persistence)
    const before = count(database.db, 'task_runs')
    const eventsBefore = count(database.db, 'events')

    await expect(
      runs.withTransaction(async (uow) => {
        await uow.saveTaskRun(taskRun({ status: 'DONE' }))
      }),
    ).rejects.toBeInstanceOf(StateWithoutEventError)

    expect(count(database.db, 'task_runs')).toBe(before)
    expect(count(database.db, 'events')).toBe(eventsBefore)
    const stored = await runs.loadTaskRuns(RUN)
    expect(stored.find((t) => t.taskId === T01)?.status).toBe('PENDING')
  })

  it('o erro de I1 aponta quais escritas ficaram sem evento', async () => {
    const { runs } = temp.persistence
    await seededRun(temp.persistence)

    const error = await runs
      .withTransaction(async (uow) => {
        await uow.saveTaskRun(taskRun({ status: 'READY' }))
        await uow.saveRun(run({ status: 'PAUSED' }))
      })
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(StateWithoutEventError)
    expect((error as StateWithoutEventError).writes).toEqual([`task_run:${T01}`, `run:${RUN}`])
  })

  it('o caminho normal sempre emite evento junto do estado', async () => {
    const { runs, database } = temp.persistence
    await seededRun(temp.persistence)
    const eventsBefore = count(database.db, 'events')

    const commit = await runs.commit(async (uow) => {
      await uow.saveTaskRun(taskRun({ status: 'READY', readyAt: new Date() }))
      await uow.appendEvent({
        runId: RUN,
        ts: new Date(),
        type: 'task.ready',
        actor: { kind: 'orchestrator' },
        taskId: T01,
        payload: { unblockedBy: [] },
      })
      return 'ok'
    })

    expect(commit.result).toBe('ok')
    expect(commit.events).toHaveLength(1)
    expect(commit.events[0]?.seq).toBeGreaterThan(0)
    expect(count(database.db, 'events')).toBe(eventsBefore + 1)
  })

  it('evento sem mudanca de estado e permitido', async () => {
    const { runs, database } = temp.persistence
    await seededRun(temp.persistence)
    const before = count(database.db, 'events')

    await runs.withTransaction(async (uow) => {
      await uow.appendEvent({
        runId: RUN,
        ts: new Date(),
        type: 'human.note_added',
        actor: { kind: 'human', id: 'ewaldo' },
        payload: { actor: 'ewaldo', note: 'observando' },
      })
    })

    expect(count(database.db, 'events')).toBe(before + 1)
  })

  it('transacao vazia e no-op', async () => {
    const { runs, database } = temp.persistence
    await seededRun(temp.persistence)
    const events = count(database.db, 'events')

    const commit = await runs.commit(async () => 42)
    expect(commit.result).toBe(42)
    expect(commit.events).toEqual([])
    expect(count(database.db, 'events')).toBe(events)
  })

  it('putStateWithoutEvent libera o caminho de recovery e so ele', async () => {
    const { runs, database } = temp.persistence
    await seededRun(temp.persistence)
    const eventsBefore = count(database.db, 'events')

    await runs.withRecoveryTransaction(async (uow) => {
      uow.putStateWithoutEvent('recovery apos queda do processo')
      await uow.saveTaskRun(taskRun({ status: 'RETRY', attemptCount: 2 }))
    })

    const stored = await runs.loadTaskRuns(RUN)
    expect(stored.find((t) => t.taskId === T01)?.status).toBe('RETRY')
    expect(count(database.db, 'events')).toBe(eventsBefore)
  })

  it('recovery sem justificativa continua sujeito a I1', async () => {
    const { runs } = temp.persistence
    await seededRun(temp.persistence)

    await expect(
      runs.withRecoveryTransaction(async (uow) => {
        await uow.saveTaskRun(taskRun({ status: 'RETRY' }))
      }),
    ).rejects.toBeInstanceOf(StateWithoutEventError)
  })

  it('justificativa vazia nao habilita a escotilha', async () => {
    const { runs } = temp.persistence
    await seededRun(temp.persistence)

    await expect(
      runs.withRecoveryTransaction(async (uow) => {
        uow.putStateWithoutEvent('   ')
        await uow.saveTaskRun(taskRun({ status: 'RETRY' }))
      }),
    ).rejects.toBeInstanceOf(StateWithoutEventError)
  })

  it('uma unidade de trabalho aplica cada escrita uma unica vez', async () => {
    const { runs, database } = temp.persistence
    await seededRun(temp.persistence)

    await runs.withTransaction(async (uow) => {
      await uow.saveTaskRun(taskRun({ status: 'RUNNING' }))
      await uow.saveAttempt(closedAttempt())
      await uow.appendEvent({
        runId: RUN,
        ts: new Date(),
        type: 'attempt.finished',
        actor: { kind: 'orchestrator' },
        taskId: T01,
        payload: { result: 'FAIL', durationMs: 876_333 },
      })
    })

    expect(count(database.db, 'attempts')).toBe(1)
    expect(count(database.db, 'events')).toBe(4)
  })
})
