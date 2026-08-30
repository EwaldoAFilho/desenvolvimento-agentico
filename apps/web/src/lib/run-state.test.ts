import { type EventDto, RunSnapshotSchema } from '@agentic/schemas'
import { describe, expect, it } from 'vitest'
import { makeEvents, makeSnapshot, taskDoneEvent } from '../__fixtures__/snapshot.js'
import { applyEvent, applyEvents, applyProviders, initRunState } from './run-state.js'

function statusOf(state: ReturnType<typeof initRunState>, id: string): string | undefined {
  return state.snapshot.tasks.find((task) => task.id === id)?.status
}

describe('fixture do contrato', () => {
  it('o snapshot de 17 nos e 7 fases satisfaz RunSnapshotSchema', () => {
    expect(() => RunSnapshotSchema.parse(makeSnapshot())).not.toThrow()
  })
})

describe('redutor de eventos', () => {
  it('inicia com o ultimo seq visto', () => {
    const state = initRunState(makeSnapshot(), makeEvents())
    expect(state.lastSeq).toBe(500)
    expect(state.events).toHaveLength(3)
  })

  it('task.done acende o dependente que fica READY, sem refazer o fetch', () => {
    const state = initRunState(makeSnapshot(), makeEvents())
    expect(statusOf(state, 'T09')).toBe('RUNNING')
    expect(statusOf(state, 'T11')).toBe('PENDING')

    const next = applyEvent(state, taskDoneEvent('T09', 501))

    expect(statusOf(next, 'T09')).toBe('DONE')
    expect(statusOf(next, 'T11')).toBe('READY')
  })

  it('nao acende dependente cuja outra dependencia continua pendente', () => {
    const state = initRunState(makeSnapshot())
    const next = applyEvent(state, taskDoneEvent('T09', 501))
    // T16 depende de T12, T13 e T15 — nenhuma concluiu.
    expect(statusOf(next, 'T16')).toBe('PENDING')
    expect(statusOf(next, 'T15')).toBe('PENDING')
  })

  it('recalcula os contadores do cabecalho a cada mudanca de estado', () => {
    const state = initRunState(makeSnapshot())
    expect(state.snapshot.counters.DONE).toBe(8)
    const next = applyEvent(state, taskDoneEvent('T09', 501))
    expect(next.snapshot.counters.DONE).toBe(9)
    expect(next.snapshot.counters.READY).toBe(2)
    expect(next.snapshot.counters.PENDING).toBe(4)
  })

  it('ignora evento com seq ja aplicado — reconexao nao duplica', () => {
    const state = initRunState(makeSnapshot())
    const done = taskDoneEvent('T09', 501)
    const once = applyEvent(state, done)
    const twice = applyEvent(once, done)
    expect(twice).toBe(once)
    expect(twice.events).toHaveLength(1)
    expect(twice.lastSeq).toBe(501)
  })

  it('reaplicar a janela inteira apos reconexao converge ao mesmo estado', () => {
    const state = initRunState(makeSnapshot())
    const stream: EventDto[] = [
      taskDoneEvent('T09', 501),
      { ...taskDoneEvent('T12', 502), taskId: 'T12' },
    ]
    const live = applyEvents(state, stream)
    const replayed = applyEvents(live, stream)
    expect(replayed).toBe(live)
    expect(replayed.events).toHaveLength(2)
  })

  it('reflete os 12 estados no no sem reload', () => {
    let state = initRunState(makeSnapshot())
    const sequence: [EventDto['type'], string][] = [
      ['task.ready', 'READY'],
      ['task.dispatched', 'RUNNING'],
      ['task.verifying', 'VERIFYING'],
      ['task.review_requested', 'REVIEW'],
      ['task.integrating', 'INTEGRATING'],
      ['task.done', 'DONE'],
      ['task.reopened', 'READY'],
      ['task.failed', 'FAILED'],
      ['task.retry_scheduled', 'RETRY'],
      ['task.blocked', 'BLOCKED'],
      ['task.unblocked', 'READY'],
      ['task.skipped', 'SKIPPED'],
      ['task.cancelled', 'CANCELLED'],
    ]
    sequence.forEach(([type, expected], index) => {
      state = applyEvent(state, {
        seq: 600 + index,
        ts: '2026-01-08T13:00:00.000Z',
        type,
        actor: { kind: 'orchestrator' },
        taskId: 'T13',
        payload: {},
      })
      expect(statusOf(state, 'T13')).toBe(expected)
    })
  })

  it('guarda o bloqueio quando o evento carrega a causa', () => {
    const state = initRunState(makeSnapshot())
    const next = applyEvent(state, {
      seq: 700,
      ts: '2026-01-08T13:00:00.000Z',
      type: 'task.blocked',
      actor: { kind: 'orchestrator' },
      taskId: 'T13',
      payload: {
        blockage: {
          kind: 'DEPENDENCY',
          reason: 'espera decisao',
          raisedBy: 'orchestrator',
          raisedAt: '2026-01-08T13:00:00.000Z',
          needs: 'humano',
        },
      },
    })
    expect(next.snapshot.tasks.find((t) => t.id === 'T13')?.blockage?.kind).toBe('DEPENDENCY')
  })

  it('attempt.started atualiza tentativa corrente', () => {
    const state = initRunState(makeSnapshot())
    const next = applyEvent(state, {
      seq: 701,
      ts: '2026-01-08T13:00:00.000Z',
      type: 'attempt.started',
      actor: { kind: 'orchestrator' },
      taskId: 'T10',
      attemptId: 'att-99',
      payload: { attemptNumber: 3 },
    })
    const task = next.snapshot.tasks.find((t) => t.id === 'T10')
    expect(task?.attemptCount).toBe(3)
    expect(task?.currentAttempt).toBe('att-99')
  })

  it('eventos de run mudam o estado do run', () => {
    const state = initRunState(makeSnapshot())
    const paused = applyEvent(state, {
      seq: 800,
      ts: '2026-01-08T13:00:00.000Z',
      type: 'run.paused',
      actor: { kind: 'human', id: 'ewaldo' },
      payload: {},
    })
    expect(paused.snapshot.run.status).toBe('PAUSED')
    const resumed = applyEvent(paused, {
      seq: 801,
      ts: '2026-01-08T13:00:05.000Z',
      type: 'run.resumed',
      actor: { kind: 'human', id: 'ewaldo' },
      payload: {},
    })
    expect(resumed.snapshot.run.status).toBe('RUNNING')
  })

  it('saude de provider chega pelo mesmo stream', () => {
    const state = initRunState(makeSnapshot())
    const next = applyProviders(state, [
      {
        providerId: 'agente-a',
        installed: true,
        ready: 'unknown',
        version: '2.1.5',
        detail: '',
        running: 3,
        capacity: 3,
      },
    ])
    expect(next.snapshot.providers).toHaveLength(1)
    expect(next.snapshot.providers[0]?.running).toBe(3)
  })

  it('o buffer de eventos nao cresce sem limite', () => {
    let state = initRunState(makeSnapshot())
    for (let i = 1; i <= 400; i += 1) {
      state = applyEvent(state, {
        seq: 1000 + i,
        ts: '2026-01-08T13:00:00.000Z',
        type: 'attempt.observed',
        actor: { kind: 'orchestrator' },
        payload: {},
      })
    }
    expect(state.events.length).toBeLessThanOrEqual(300)
    expect(state.lastSeq).toBe(1400)
  })
})
