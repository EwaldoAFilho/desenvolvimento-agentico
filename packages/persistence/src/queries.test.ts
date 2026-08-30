import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathScope } from '@agentic/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  attempt,
  closedAttempt,
  event,
  gateExecution,
  LATER,
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

async function seedExecution(): Promise<void> {
  await seededRun(temp.persistence)
  await temp.persistence.runs.withTransaction(async (uow) => {
    await uow.saveAttempt(closedAttempt({ gateExecutions: [gateExecution()], review: review() }))
    await uow.saveTaskRun(
      taskRun({ status: 'RUNNING', attemptCount: 1, currentAttemptId: attempt().id }),
    )
    await uow.acquireLock(RUN, pathScope('packages/persistence/'), attempt().id, LATER)
    await uow.appendEvent(
      event({
        type: 'task.dispatched',
        taskId: T01,
        payload: { executor: attempt().executor, dispatchReason: attempt().dispatchReason },
      }),
    )
  })
}

describe('getRunSnapshotData', () => {
  it('devolve run, task_runs, tentativas correntes e o ultimo seq', async () => {
    await seedExecution()
    const snapshot = temp.persistence.queries.getRunSnapshotData(RUN)

    expect(snapshot.run?.id).toBe(RUN)
    expect(snapshot.run?.mission_id).toBe('DA-CORE-001')
    expect(snapshot.taskRuns.map((t) => t.task_id)).toEqual([T01, T02])
    expect(snapshot.currentAttempts.map((a) => a.id)).toEqual([attempt().id])
    expect(snapshot.latestSeq).toBe(temp.persistence.events.latestSeq(RUN))
  })

  it('agrega contagem por status de task', async () => {
    await seedExecution()
    const snapshot = temp.persistence.queries.getRunSnapshotData(RUN)
    expect(snapshot.statusCounts).toEqual([
      { status: 'PENDING', total: 1 },
      { status: 'RUNNING', total: 1 },
    ])
  })

  it('run inexistente devolve snapshot vazio, nao erro', async () => {
    const snapshot = temp.persistence.queries.getRunSnapshotData(RUN)
    expect(snapshot.run).toBeUndefined()
    expect(snapshot.taskRuns).toEqual([])
    expect(snapshot.latestSeq).toBe(0)
  })
})

describe('listRuns', () => {
  it('traz contagem de tasks e de tasks concluidas', async () => {
    await seededRun(temp.persistence)
    await temp.persistence.runs.withTransaction(async (uow) => {
      await uow.saveTaskRun(taskRun({ status: 'DONE', finishedAt: LATER }))
      await uow.appendEvent(event({ type: 'task.done', taskId: T01, payload: { evidence: [] } }))
    })

    const [row] = temp.persistence.queries.listRuns()
    expect(row?.task_total).toBe(2)
    expect(row?.task_done).toBe(1)
  })

  it('filtra por status e limite', async () => {
    await seededRun(temp.persistence)
    await seededRun(temp.persistence, run({ id: RUN_B, status: 'COMPLETED', createdAt: LATER }))

    expect(temp.persistence.queries.listRuns({ status: ['COMPLETED'] }).map((r) => r.id)).toEqual([
      RUN_B,
    ])
    expect(temp.persistence.queries.listRuns({ limit: 1 })).toHaveLength(1)
    expect(temp.persistence.queries.listRuns()).toHaveLength(2)
  })
})

describe('getTaskDetailData', () => {
  it('reune tentativa, gate, revisao, lock e artefatos da task', async () => {
    await seedExecution()
    await temp.persistence.artifacts.write({
      runId: RUN,
      kind: 'patch',
      relativePath: 'attempts/T01-a1/patch.diff',
      content: 'diff',
    })

    const detail = temp.persistence.queries.getTaskDetailData(RUN, T01)
    expect(detail.taskRun?.status).toBe('RUNNING')
    expect(detail.attempts.map((a) => a.id)).toEqual([attempt().id])
    expect(detail.gateExecutions.map((g) => g.id)).toEqual(['gx-1'])
    expect(detail.reviews.map((r) => r.id)).toEqual(['rv-1'])
    expect(detail.locks.map((l) => l.path_prefix)).toEqual(['packages/persistence/'])
    expect(detail.artifacts).toHaveLength(1)
  })

  it('task sem tentativa devolve listas vazias', async () => {
    await seededRun(temp.persistence)
    const detail = temp.persistence.queries.getTaskDetailData(RUN, T02)
    expect(detail.taskRun?.task_id).toBe(T02)
    expect(detail.attempts).toEqual([])
    expect(detail.gateExecutions).toEqual([])
    expect(detail.reviews).toEqual([])
  })

  it('devolve linha crua, com os nomes de coluna do banco', async () => {
    await seedExecution()
    const detail = temp.persistence.queries.getTaskDetailData(RUN, T01)
    expect(Object.keys(detail.attempts[0] ?? {})).toContain('dispatch_reason_json')
    expect(Object.keys(detail.attempts[0] ?? {})).toContain('observation_json')
  })
})

describe('readEvents', () => {
  it('sinceSeq exclusivo, ordenado e sem repeticao', async () => {
    await seededRun(temp.persistence)
    for (let i = 0; i < 6; i += 1) await temp.persistence.events.append(event())

    const all = temp.persistence.queries.readEvents({ runId: RUN })
    const seqs = all.map((row) => row.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))

    const first = seqs[2]
    expect(first).toBeDefined()
    if (first === undefined) return
    const rest = temp.persistence.queries.readEvents({ runId: RUN, sinceSeq: first })
    expect(rest.map((row) => row.seq)).toEqual(seqs.slice(3))
  })

  it('respeita limite e filtro de tipo', async () => {
    await seededRun(temp.persistence)
    await temp.persistence.events.append(event({ type: 'run.paused', payload: { reason: 'x' } }))

    expect(temp.persistence.queries.readEvents({ runId: RUN, limit: 2 })).toHaveLength(2)
    expect(temp.persistence.queries.readEvents({ runId: RUN, types: ['run.paused'] })).toHaveLength(
      1,
    )
  })

  it('nao devolve evento de outro run', async () => {
    await seededRun(temp.persistence)
    await seededRun(temp.persistence, run({ id: RUN_B }))
    const rows = temp.persistence.queries.readEvents({ runId: RUN_B })
    expect(rows.every((row) => row.run_id === RUN_B)).toBe(true)
  })
})

/** Montado em partes de proposito: o proprio teste nao pode casar com a busca. */
const FORBIDDEN_IMPORT = ['@agentic', 'schemas'].join('/')

describe('fronteira do pacote', () => {
  it('nenhum modulo importa @agentic/schemas', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const files = readdirSync(here).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    )
    for (const name of files) {
      const source = readFileSync(join(here, name), 'utf8')
      expect(source.includes(FORBIDDEN_IMPORT)).toBe(false)
    }
  })
})
