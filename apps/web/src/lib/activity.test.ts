import type { EventDto } from '@agentic/schemas'
import { describe, expect, it } from 'vitest'
import {
  makeLiveTaskDetail,
  makeNoChangesTaskDetail,
  makeTaskDetail,
} from '../__fixtures__/snapshot.js'
import { activityPulse, activityTimeline, logRefsFromEvents } from './activity.js'

const NOW = Date.parse('2026-01-08T12:45:42.000Z')

describe('atividade derivada dos eventos', () => {
  it('mostra agente iniciado, processo ativo, gate e revisao — nesta ordem', () => {
    const steps = activityTimeline(makeLiveTaskDetail().events)
    expect(steps.map((step) => step.kind)).toEqual([
      'workspace-ready',
      'agent-started',
      'process-active',
      'gate-started',
      'gate-finished',
      'review-started',
    ])
    expect(steps.map((step) => step.label)).toEqual([
      'worktree preparada',
      'agente iniciado (tentativa 2)',
      'processo ativo — diff observado',
      'gate iniciado',
      'gate concluído (FAIL)',
      'revisão iniciada',
    ])
  })

  it('cada passo cita o evento medido que o originou', () => {
    const steps = activityTimeline(makeLiveTaskDetail().events)
    expect(steps.map((step) => step.source)).toContain('gate.finished')
    expect(steps.every((step) => step.seq > 0)).toBe(true)
  })

  it('ignora o relato do agente: `claims` no payload nao vira atividade', () => {
    const events = makeLiveTaskDetail().events
    const started = events.find((event) => event.type === 'attempt.started')
    expect(started?.payload.claims).toBeDefined()
    const steps = activityTimeline(events)
    expect(steps.some((step) => JSON.stringify(step).includes('claims'))).toBe(false)
  })

  it('ordena por seq, nao pela ordem de chegada na aba', () => {
    const events = [...makeLiveTaskDetail().events].reverse()
    const steps = activityTimeline(events)
    expect(steps.map((step) => step.seq)).toEqual([...steps.map((step) => step.seq)].sort())
  })

  it('evento sem leitura de atividade nao entra na linha do tempo', () => {
    const noise: EventDto = {
      seq: 900,
      ts: '2026-01-08T12:46:00.000Z',
      type: 'policy.scope_violation',
      actor: { kind: 'orchestrator' },
      taskId: 'T09',
      payload: { outOfScopePaths: ['x'], occurrence: 1 },
    }
    expect(activityTimeline([noise])).toEqual([])
  })

  it('pulso: vivo enquanto nada encerrou a tentativa, com o tempo desde o ultimo sinal', () => {
    const pulse = activityPulse(makeLiveTaskDetail().events, NOW)
    expect(pulse.live).toBe(true)
    expect(pulse.last?.kind).toBe('review-started')
    expect(pulse.sinceMs).toBe(30_000)
  })

  it('pulso: encerrado quando o ultimo evento fecha a task', () => {
    const pulse = activityPulse(makeNoChangesTaskDetail().events, NOW)
    expect(pulse.live).toBe(false)
    expect(pulse.last?.label).toBe('task falhou')
  })

  it('sem evento nenhum, o pulso admite que nao ha sinal medido', () => {
    const pulse = activityPulse([], NOW)
    expect(pulse.live).toBe(false)
    expect(pulse.last).toBeUndefined()
    expect(pulse.steps).toEqual([])
  })

  it('encontra a referencia do diff observado no payload do evento', () => {
    const refs = logRefsFromEvents(makeLiveTaskDetail().events)
    expect(refs.map((ref) => ref.ref)).toContain('runs/01J8ZC/T09/a2/diff.patch')
  })

  it('reconhece a referencia de log do agente com o nome do dominio (`logsRef`)', () => {
    const event: EventDto = {
      seq: 950,
      ts: '2026-01-08T12:46:00.000Z',
      type: 'attempt.finished',
      actor: { kind: 'orchestrator' },
      taskId: 'T02',
      payload: { result: 'FAIL', logsRef: 'runs/01M1AEP/T02/a2/agent.log.jsonl' },
    }
    expect(logRefsFromEvents([event]).map((ref) => ref.ref)).toEqual([
      'runs/01M1AEP/T02/a2/agent.log.jsonl',
    ])
  })

  it('sem referencia persistida, nao inventa uma', () => {
    expect(logRefsFromEvents(makeNoChangesTaskDetail().events)).toEqual([])
    expect(logRefsFromEvents(makeTaskDetail().events)).toEqual([])
  })
})
