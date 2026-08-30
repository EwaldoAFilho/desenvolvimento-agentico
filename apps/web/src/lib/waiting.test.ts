import { describe, expect, it } from 'vitest'
import {
  ATTEMPTS_EXHAUSTED_BLOCKAGE,
  CROSS_PROVIDER_BLOCKAGE,
  makeSnapshot,
  withRunStatus,
  withSaturatedProviders,
  withTaskStatus,
} from '../__fixtures__/snapshot.js'
import { stalledDependents, waitingReasonOf, waitingReasons } from './waiting.js'

describe('motivo de espera', () => {
  it('task em execucao nao espera nada', () => {
    expect(waitingReasonOf(makeSnapshot(), 'T09')).toBeUndefined()
    expect(waitingReasonOf(makeSnapshot(), 'T01')).toBeUndefined()
  })

  it('aguardando a dependencia que ainda nao concluiu, nomeada', () => {
    const reason = waitingReasonOf(makeSnapshot(), 'T11')
    expect(reason?.cause).toBe('dependencies')
    expect(reason?.summary).toBe('aguardando T09')
    expect(reason?.detail).toContain('T09 (RUNNING)')
    expect(reason?.waitingOn.map((dependency) => dependency.id)).toEqual(['T09'])
  })

  it('lista todas as dependencias pendentes, nao so a primeira', () => {
    const reason = waitingReasonOf(makeSnapshot(), 'T16')
    expect(reason?.summary).toBe('aguardando T12, T13, T15')
  })

  it('aguardando revisor de outro fornecedor quando a politica nao tem como ser satisfeita', () => {
    const snapshot = withTaskStatus(makeSnapshot(), 'T12', {
      status: 'BLOCKED',
      blockage: CROSS_PROVIDER_BLOCKAGE,
    })
    const reason = waitingReasonOf(snapshot, 'T12')
    expect(reason?.cause).toBe('cross-provider-review')
    expect(reason?.summary).toBe('aguardando revisor de outro fornecedor')
    expect(reason?.needs).toContain('segundo fornecedor apto a revisar')
  })

  it('aguardando capacidade do fornecedor quando nenhum tem vaga', () => {
    const snapshot = withSaturatedProviders(makeSnapshot())
    const reason = waitingReasonOf(snapshot, 'T12')
    expect(reason?.cause).toBe('provider-capacity')
    expect(reason?.summary).toBe('aguardando capacidade do fornecedor')
    expect(reason?.detail).toContain('agente-a 3/3')
  })

  it('aguardando aprovacao da missao enquanto o run e DRAFT', () => {
    const snapshot = withRunStatus(makeSnapshot(), 'DRAFT')
    const reason = waitingReasonOf(snapshot, 'T12')
    expect(reason?.cause).toBe('mission-approval')
    expect(reason?.summary).toBe('aguardando aprovação da missão')
    expect(reason?.needs).toBe('aprovação da missão')
  })

  it('run pausado espera retomada, nao capacidade', () => {
    const snapshot = withRunStatus(makeSnapshot(), 'PAUSED')
    const reason = waitingReasonOf(snapshot, 'T12')
    expect(reason?.cause).toBe('run-not-running')
    expect(reason?.summary).toBe('aguardando retomada do run')
    expect(reason?.needs).toBe('resume do run')
  })

  it('RETRY espera a nova tentativa, com o backoff da politica', () => {
    const reason = waitingReasonOf(makeSnapshot(), 'T10')
    expect(reason?.cause).toBe('retry-backoff')
    expect(reason?.summary).toBe('aguardando nova tentativa')
    expect(reason?.detail).toContain('15000ms')
  })

  it('tentativas esgotadas viram espera por decisao humana', () => {
    const snapshot = withTaskStatus(makeSnapshot(), 'T12', {
      status: 'BLOCKED',
      blockage: ATTEMPTS_EXHAUSTED_BLOCKAGE,
    })
    const reason = waitingReasonOf(snapshot, 'T12')
    expect(reason?.cause).toBe('attempts-exhausted')
    expect(reason?.detail).toContain('orçamento de tentativas esgotado')
  })

  it('bloqueio arquitetural pede decisao humana e diz o que resolve', () => {
    const reason = waitingReasonOf(makeSnapshot(), 'T14')
    expect(reason?.cause).toBe('human-decision')
    expect(reason?.detail).toContain('ARCHITECTURAL')
    expect(reason?.needs).toBe('decisao humana sobre o formato do slot')
  })

  it('READY com capacidade livre so aguarda o proximo despacho', () => {
    const reason = waitingReasonOf(makeSnapshot(), 'T12')
    expect(reason?.cause).toBe('dispatch')
  })

  it('limite de paralelismo do run e espera de vaga, nao de fornecedor', () => {
    let snapshot = makeSnapshot()
    for (const id of ['T11', 'T13', 'T15']) {
      snapshot = withTaskStatus(snapshot, id, { status: 'RUNNING' })
    }
    const reason = waitingReasonOf(snapshot, 'T12')
    expect(reason?.cause).toBe('run-capacity')
    expect(reason?.detail).toContain('maxParallelTasks 3')
  })

  it('bloqueio ja resolvido nao continua sendo o motivo da espera', () => {
    const snapshot = withTaskStatus(makeSnapshot(), 'T11', {
      blockage: { ...CROSS_PROVIDER_BLOCKAGE, resolvedAt: '2026-01-08T12:40:00.000Z' },
    })
    expect(waitingReasonOf(snapshot, 'T11')?.cause).toBe('dependencies')
  })

  it('o mapa cobre toda task parada e nenhuma em andamento', () => {
    const snapshot = makeSnapshot()
    const reasons = waitingReasons(snapshot)
    expect(reasons.has('T09')).toBe(false)
    expect(reasons.has('T01')).toBe(false)
    for (const task of snapshot.tasks) {
      const waiting = ['PENDING', 'READY', 'RETRY', 'BLOCKED'].includes(task.status)
      expect(reasons.has(task.id)).toBe(waiting)
    }
  })
})

describe('dependentes parados', () => {
  it('alcanca direto e indireto, sempre com o estado de cada um', () => {
    const stalled = stalledDependents(makeSnapshot(), 'T09')
    expect(stalled.map((dependent) => dependent.id)).toEqual(['T11', 'T15', 'T16', 'T17'])
    expect(stalled.find((dependent) => dependent.id === 'T11')?.direct).toBe(true)
    expect(stalled.find((dependent) => dependent.id === 'T16')?.direct).toBe(false)
    expect(stalled.every((dependent) => dependent.status === 'PENDING')).toBe(true)
  })

  it('nao conta dependente que ja concluiu', () => {
    expect(stalledDependents(makeSnapshot(), 'T01').map((d) => d.id)).not.toContain('T03')
  })

  it('folha do grafo nao tem ninguem parado atras', () => {
    expect(stalledDependents(makeSnapshot(), 'T17')).toEqual([])
  })
})
