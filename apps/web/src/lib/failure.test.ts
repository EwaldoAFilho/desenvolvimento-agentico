import type { EventDto, TaskDetail } from '@agentic/schemas'
import { describe, expect, it } from 'vitest'
import {
  makeBlockedTaskDetail,
  makeLiveTaskDetail,
  makeNoChangesTaskDetail,
  makeScopeViolationTaskDetail,
  makeSnapshot,
  makeTaskDetail,
} from '../__fixtures__/snapshot.js'
import { blockedViewOf, failureViewOf, isFailureStatus, logRefsOf } from './failure.js'
import { stalledDependents } from './waiting.js'

const RETRY_SCHEDULED: EventDto = {
  seq: 700,
  ts: '2026-01-08T12:49:00.000Z',
  type: 'task.retry_scheduled',
  actor: { kind: 'orchestrator' },
  taskId: 'T09',
  payload: { attemptCount: 2, backoffMs: 15_000 },
}

describe('UX de falha', () => {
  it('NO_CHANGES do smoke real: codigo, tentativa, fornecedor e gate que nao rodou', () => {
    const view = failureViewOf(makeNoChangesTaskDetail())
    expect(view?.code).toBe('NO_CHANGES')
    expect(view?.detail).toBe('nenhum arquivo alterado na worktree')
    expect(view?.attempt).toEqual({ number: 2, max: 2 })
    expect(view?.provider).toBe('agente-a')
    expect(view?.gate.reach).toBe('not-reached')
    expect(view?.gate.label).toBe('não chegou a rodar')
    expect(view?.gate.commands).toBe(0)
  })

  it('orcamento consumido: nao promete retry que nao existe', () => {
    const view = failureViewOf(makeNoChangesTaskDetail())
    expect(view?.retry).toBe('exhausted')
    expect(view?.retryDetail).toContain('2 de 2')
  })

  it('violacao de escopo aparece com os caminhos exatos', () => {
    const view = failureViewOf(makeScopeViolationTaskDetail())
    expect(view?.code).toBe('SCOPE_VIOLATION')
    expect(view?.scope.violated).toBe(true)
    expect(view?.scope.paths).toEqual(['packages/dominio/regra.ts', '.agentic/state.db'])
  })

  it('gate que rodou e concluiu aparece com o veredito', () => {
    const view = failureViewOf(makeScopeViolationTaskDetail())
    expect(view?.gate.reach).toBe('finished')
    expect(view?.gate.status).toBe('FAIL')
    expect(view?.gate.label).toContain('concluído')
  })

  it('sem violacao, diz que nenhum caminho saiu de touches', () => {
    const view = failureViewOf(makeTaskDetail())
    expect(view?.scope.violated).toBe(false)
    expect(view?.scope.paths).toEqual([])
  })

  it('retry disponivel enquanto sobra orcamento de tentativas', () => {
    const view = failureViewOf(makeTaskDetail())
    expect(view?.retry).toBe('available')
    expect(view?.retryDetail).toContain('restam 1 de 3')
  })

  it('retry ja agendado pelo orquestrador nao vira convite a agir', () => {
    const task = makeTaskDetail()
    const view = failureViewOf({ ...task, events: [...task.events, RETRY_SCHEDULED] })
    expect(view?.retry).toBe('scheduled')
  })

  it('task sem falha nao produz relato de falha', () => {
    const task: TaskDetail = { ...makeTaskDetail(), failure: undefined }
    expect(failureViewOf(task)).toBeUndefined()
  })

  it('estados de falha sao FAILED, RETRY e BLOCKED', () => {
    expect(isFailureStatus('FAILED')).toBe(true)
    expect(isFailureStatus('RETRY')).toBe(true)
    expect(isFailureStatus('BLOCKED')).toBe(true)
    expect(isFailureStatus('RUNNING')).toBe(false)
    expect(isFailureStatus('DONE')).toBe(false)
  })
})

describe('UX de bloqueio', () => {
  it('diz por que, o que resolve e quem ficou parado atras', () => {
    const task = makeBlockedTaskDetail()
    const view = blockedViewOf(task, stalledDependents(makeSnapshot(), task.id))
    expect(view?.kind).toBe('POLICY')
    expect(view?.reason).toBe('CROSS_PROVIDER_UNAVAILABLE')
    expect(view?.needs).toContain('segundo fornecedor apto a revisar')
    expect(view?.dependents.map((dependent) => dependent.id)).toEqual(['T11', 'T15', 'T16', 'T17'])
  })

  it('task sem bloqueio nao produz relato de bloqueio', () => {
    expect(blockedViewOf(makeTaskDetail())).toBeUndefined()
  })

  it('a propria task nunca conta como dependente parado', () => {
    const task = makeBlockedTaskDetail()
    const view = blockedViewOf(task, [{ id: task.id, status: 'BLOCKED', direct: true }])
    expect(view?.dependents).toEqual([])
  })
})

describe('referencias de log', () => {
  it('reune saida de gate e evidencia citavel', () => {
    const refs = logRefsOf(makeTaskDetail())
    expect(refs.map((ref) => ref.ref)).toEqual([
      'runs/01J8ZC/T09/a2/test.log',
      'runs/01J8ZC/T09/a2/gate.json',
    ])
    expect(refs[0]?.origin).toBe('gate')
    expect(refs[1]?.origin).toBe('evidence')
  })

  it('inclui a referencia do diff observado quando o evento a traz', () => {
    const refs = logRefsOf(makeLiveTaskDetail())
    expect(refs.map((ref) => ref.ref)).toContain('runs/01J8ZC/T09/a2/diff.patch')
  })

  it('quando nao ha log do agente persistido, a lista fica vazia — sem fingir', () => {
    expect(logRefsOf(makeNoChangesTaskDetail())).toEqual([])
  })
})
