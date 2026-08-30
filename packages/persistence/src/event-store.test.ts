import type { DomainEvent } from '@agentic/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  event,
  LATER,
  NOW,
  RUN,
  RUN_B,
  run,
  seededRun,
  T01,
  type TempPersistence,
  tempPersistence,
} from './__fixtures__/builders.js'
import { openPersistence } from './persistence.js'

let temp: TempPersistence

beforeEach(async () => {
  temp = await tempPersistence()
})

afterEach(async () => {
  await temp.dispose()
})

describe('append', () => {
  it('devolve o evento com o seq atribuido pelo banco', async () => {
    const stored = await temp.persistence.events.append(event())
    expect(stored.seq).toBe(1)
    expect(stored.type).toBe('run.started')
    expect(stored.ts.getTime()).toBe(NOW.getTime())
  })

  it('preserva actor, taskId e payload', async () => {
    const stored = await temp.persistence.events.append(
      event({
        type: 'policy.scope_violation',
        taskId: T01,
        actor: { kind: 'system' },
        payload: { outOfScopePaths: ['packages/domain/'], occurrence: 2 },
      }),
    )
    expect(stored.actor).toEqual({ kind: 'system' })
    expect(stored.taskId).toBe(T01)
    expect(stored.payload).toEqual({ outOfScopePaths: ['packages/domain/'], occurrence: 2 })
  })

  it('Date dentro do payload volta como Date', async () => {
    const stored = await temp.persistence.events.append(
      event({
        type: 'human.mission_approved',
        actor: { kind: 'human', id: 'ewaldo' },
        payload: { actor: 'ewaldo', at: LATER },
      }),
    )
    const payload = stored.payload as { at: Date }
    expect(payload.at).toBeInstanceOf(Date)
    expect(payload.at.getTime()).toBe(LATER.getTime())
  })
})

describe('seq', () => {
  it('e monotonico e sem buraco', async () => {
    const { events } = temp.persistence
    const written: DomainEvent[] = []
    for (let i = 0; i < 25; i += 1) written.push(await events.append(event()))

    const seqs = written.map((e) => e.seq)
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(events.latestSeq(RUN)).toBe(25)
  })

  it('e global e crescente mesmo com runs intercalados', async () => {
    const { events } = temp.persistence
    const a1 = await events.append(event())
    const b1 = await events.append(event({ runId: RUN_B }))
    const a2 = await events.append(event())

    expect(b1.seq).toBeGreaterThan(a1.seq)
    expect(a2.seq).toBeGreaterThan(b1.seq)
    expect((await events.list(RUN)).map((e) => e.seq)).toEqual([a1.seq, a2.seq])
  })

  it('continua crescendo depois de reabrir o banco', async () => {
    await temp.persistence.events.append(event())
    await temp.persistence.events.append(event())
    temp.persistence.close()

    const reopened = openPersistence({ baseDir: temp.dir })
    const next = await reopened.events.append(event())
    expect(next.seq).toBe(3)
    reopened.close()
  })
})

describe('list / afterSeq', () => {
  it('afterSeq e exclusivo: nao perde nem duplica evento', async () => {
    const { events } = temp.persistence
    for (let i = 0; i < 12; i += 1) await events.append(event())

    const collected: number[] = []
    let cursor = 0
    for (let page = 0; page < 10; page += 1) {
      const batch = await events.list(RUN, { afterSeq: cursor, limit: 5 })
      if (batch.length === 0) break
      for (const item of batch) collected.push(item.seq)
      const last = batch[batch.length - 1]
      if (last === undefined) break
      cursor = last.seq
    }

    expect(collected).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(new Set(collected).size).toBe(collected.length)
  })

  it('afterSeq no ultimo seq devolve vazio', async () => {
    const { events } = temp.persistence
    const last = await events.append(event())
    expect(await events.list(RUN, { afterSeq: last.seq })).toEqual([])
  })

  it('filtra por tipo', async () => {
    const { events } = temp.persistence
    await events.append(event())
    await events.append(event({ type: 'run.paused', payload: { reason: 'cafe' } }))
    await events.append(event({ type: 'run.resumed', payload: {} }))

    const paused = await events.list(RUN, { types: ['run.paused'] })
    expect(paused.map((e) => e.type)).toEqual(['run.paused'])
  })

  it('respeita o limite', async () => {
    const { events } = temp.persistence
    for (let i = 0; i < 5; i += 1) await events.append(event())
    expect(await events.list(RUN, { limit: 2 })).toHaveLength(2)
  })

  it('nao mistura eventos de outro run', async () => {
    const { events } = temp.persistence
    await events.append(event())
    await events.append(event({ runId: RUN_B }))
    expect(await events.list(RUN_B)).toHaveLength(1)
    expect(events.count(RUN_B)).toBe(1)
    expect(events.count()).toBe(2)
  })
})

describe('subscribe', () => {
  it('entrega o backlog a partir de afterSeq e depois o que chegar', async () => {
    const { events, runs } = temp.persistence
    await seededRun(temp.persistence, run())
    const baseline = events.latestSeq(RUN)

    const received: DomainEvent[] = []
    const consumer = (async (): Promise<void> => {
      for await (const item of events.subscribe(RUN, baseline)) {
        received.push(item)
        if (received.length === 2) break
      }
    })()

    await runs.withTransaction(async (uow) => {
      await uow.appendEvent(event({ type: 'run.paused', payload: { reason: 'pausa' } }))
    })
    await runs.withTransaction(async (uow) => {
      await uow.appendEvent(event({ type: 'run.resumed', payload: { reason: 'volta' } }))
    })

    await consumer
    expect(received.map((e) => e.type)).toEqual(['run.paused', 'run.resumed'])
    expect(received[0]?.seq).toBe(baseline + 1)
  })

  it('termina quando o store fecha', async () => {
    const { events } = temp.persistence
    const received: DomainEvent[] = []
    const consumer = (async (): Promise<void> => {
      for await (const item of events.subscribe(RUN, 0)) received.push(item)
    })()

    await events.append(event())
    events.close()
    await consumer
    expect(received.length).toBeGreaterThanOrEqual(1)
  })
})
