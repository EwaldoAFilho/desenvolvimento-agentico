import { attemptId } from '@agentic/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  attempt,
  closedAttempt,
  event,
  LATER,
  NOW,
  RUN,
  seededRun,
  T01,
  type TempPersistence,
  tempPersistence,
} from './__fixtures__/builders.js'

let temp: TempPersistence

beforeEach(async () => {
  temp = await tempPersistence()
  await seededRun(temp.persistence)
})

afterEach(async () => {
  await temp.dispose()
})

async function saveAttempt(source = attempt()): Promise<void> {
  await temp.persistence.runs.withTransaction(async (uow) => {
    await uow.saveAttempt(source)
    await uow.appendEvent(
      event({
        type: 'attempt.started',
        taskId: T01,
        payload: { attemptNumber: source.attemptNumber, workspace: source.workspace },
      }),
    )
  })
}

describe('I5 — tentativa encerrada nunca e alterada', () => {
  it('fechar uma tentativa aberta e permitido', async () => {
    await saveAttempt()
    await saveAttempt(closedAttempt())

    const [stored] = await temp.persistence.runs.loadAttempts(RUN, T01)
    expect(stored?.finishedAt?.getTime()).toBe(LATER.getTime())
    expect(stored?.result).toBe('FAIL')
  })

  it('UPDATE em tentativa encerrada e rejeitado pelo banco', async () => {
    await saveAttempt(closedAttempt())

    expect(() => {
      temp.persistence.database.db
        .prepare("UPDATE attempts SET result = 'PASS' WHERE id = ?")
        .run(attempt().id)
    }).toThrow(/I5/)
  })

  it('regravar uma tentativa encerrada pela porta tambem e rejeitado', async () => {
    await saveAttempt(closedAttempt())

    await expect(saveAttempt(closedAttempt({ result: 'PASS' }))).rejects.toThrow(/I5/)

    const [stored] = await temp.persistence.runs.loadAttempts(RUN, T01)
    expect(stored?.result).toBe('FAIL')
  })

  it('a rejeicao de I5 nao deixa o evento da mesma transacao passar', async () => {
    await saveAttempt(closedAttempt())
    const before = temp.persistence.events.count(RUN)

    await expect(saveAttempt(closedAttempt({ result: 'PASS' }))).rejects.toThrow()
    expect(temp.persistence.events.count(RUN)).toBe(before)
  })

  it('DELETE de tentativa e rejeitado', async () => {
    await saveAttempt()

    expect(() => {
      temp.persistence.database.db.prepare('DELETE FROM attempts WHERE id = ?').run(attempt().id)
    }).toThrow(/I5/)
  })

  it('outra tentativa da mesma task continua gravavel', async () => {
    await saveAttempt(closedAttempt())
    await saveAttempt(attempt({ id: attemptId('att-2'), attemptNumber: 2, startedAt: LATER }))

    expect(await temp.persistence.runs.loadAttempts(RUN, T01)).toHaveLength(2)
  })
})

describe('P12 — evento gravado e imutavel', () => {
  it('UPDATE em evento e rejeitado', async () => {
    const stored = await temp.persistence.events.append(event())

    expect(() => {
      temp.persistence.database.db
        .prepare("UPDATE events SET type = 'run.failed' WHERE seq = ?")
        .run(stored.seq)
    }).toThrow(/P12/)
  })

  it('DELETE de evento e rejeitado', async () => {
    const stored = await temp.persistence.events.append(event())

    expect(() => {
      temp.persistence.database.db.prepare('DELETE FROM events WHERE seq = ?').run(stored.seq)
    }).toThrow(/P12/)
  })

  it('o log continua integro depois das tentativas de alteracao', async () => {
    const stored = await temp.persistence.events.append(event({ ts: NOW }))
    try {
      temp.persistence.database.db.prepare('DELETE FROM events WHERE seq = ?').run(stored.seq)
    } catch {
      // esperado
    }
    const events = await temp.persistence.events.list(RUN, { afterSeq: stored.seq - 1 })
    expect(events[0]?.seq).toBe(stored.seq)
    expect(events[0]?.ts.getTime()).toBe(NOW.getTime())
  })
})
