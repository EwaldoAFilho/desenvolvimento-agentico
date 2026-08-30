import { describe, expect, it } from 'vitest'
import {
  attempt,
  doneEvidence,
  EXECUTOR,
  identity,
  NOW,
  T01,
  T02,
} from './__fixtures__/builders.js'
import { attemptId, providerId } from './ids.js'
import {
  checkAgentCwd,
  checkAttemptBudget,
  checkAttemptImmutable,
  checkDoneEvidence,
  checkNoOverlappingTouches,
  checkPolicyNotSilentlyDowngraded,
  checkProviderCapacity,
  checkReviewerIsNotExecutor,
  checkRunningHasLease,
  checkSingleWriter,
  checkStateAndEventTogether,
  INVARIANT_IDS,
  invariants,
  violations,
} from './invariants.js'
import { pathScope } from './path-scope.js'
import type { CapacitySnapshot } from './ports/agent-provider.js'

const capacity = (running: number, maxConcurrent: number): CapacitySnapshot => ({
  global: { maxParallelTasks: 3, active: running },
  executor: { max: 3, active: running },
  reviewer: { max: 2, active: 0 },
  byProvider: { 'p-alpha': { maxConcurrent, running } },
})

describe('invariantes I1..I11', () => {
  it('expoe os onze invariantes indexados', () => {
    expect(INVARIANT_IDS).toHaveLength(11)
    expect(Object.keys(invariants)).toEqual([...INVARIANT_IDS])
  })

  it('I1 — estado sem evento (ou vice-versa) e violacao', () => {
    expect(checkStateAndEventTogether({ stateWrites: 1, eventWrites: 1 }).ok).toBe(true)
    expect(checkStateAndEventTogether({ stateWrites: 0, eventWrites: 0 }).ok).toBe(true)
    expect(checkStateAndEventTogether({ stateWrites: 1, eventWrites: 0 }).ok).toBe(false)
    expect(checkStateAndEventTogether({ stateWrites: 0, eventWrites: 2 }).ok).toBe(false)
  })

  it('I2 — duas tasks RUNNING nao podem sobrepor touches', () => {
    expect(
      checkNoOverlappingTouches([
        { taskId: T01, touches: [pathScope('packages/domain/')] },
        { taskId: T02, touches: [pathScope('packages/graph/')] },
      ]).ok,
    ).toBe(true)
    const conflito = checkNoOverlappingTouches([
      { taskId: T01, touches: [pathScope('packages/')] },
      { taskId: T02, touches: [pathScope('packages/graph/src/a.ts')] },
    ])
    expect(conflito.ok).toBe(false)
    expect(conflito.id).toBe('I2')
  })

  it('I3 — revisor nao pode ser o executor', () => {
    expect(checkReviewerIsNotExecutor({ requireReview: false, executor: EXECUTOR }).ok).toBe(true)
    expect(checkReviewerIsNotExecutor({ requireReview: true, executor: EXECUTOR }).ok).toBe(false)
    expect(
      checkReviewerIsNotExecutor({
        requireReview: true,
        executor: EXECUTOR,
        reviewer: EXECUTOR,
      }).ok,
    ).toBe(false)
    expect(
      checkReviewerIsNotExecutor({
        requireReview: true,
        executor: EXECUTOR,
        reviewer: identity('outra', 'p-beta', 'reviewer'),
      }).ok,
    ).toBe(true)
  })

  it('I4 — attemptCount <= maxAttempts', () => {
    expect(checkAttemptBudget({ attemptCount: 3, maxAttempts: 3 }).ok).toBe(true)
    expect(checkAttemptBudget({ attemptCount: 4, maxAttempts: 3 }).ok).toBe(false)
  })

  it('I5 — tentativa encerrada e imutavel; aberta pode mudar', () => {
    const aberta = attempt()
    expect(checkAttemptImmutable(aberta, { ...aberta, result: 'PASS' }).ok).toBe(true)

    const fechada = attempt({ finishedAt: NOW, result: 'PASS' })
    expect(checkAttemptImmutable(fechada, { ...fechada }).ok).toBe(true)
    expect(checkAttemptImmutable(fechada, { ...fechada, result: 'FAIL' }).ok).toBe(false)
    expect(
      checkAttemptImmutable(fechada, { ...fechada, failureReason: { code: 'AGENT_ERROR' } }).ok,
    ).toBe(false)
  })

  it('I6 — DONE so com a evidencia exigida', () => {
    expect(checkDoneEvidence(doneEvidence()).ok).toBe(true)
    expect(checkDoneEvidence(doneEvidence({ evidence: [] })).ok).toBe(false)
  })

  it('I7 — apenas o orquestrador escreve estado do run', () => {
    expect(checkSingleWriter({ kind: 'orchestrator' }).ok).toBe(true)
    expect(checkSingleWriter({ kind: 'agent', id: 'x' }).ok).toBe(false)
    expect(checkSingleWriter({ kind: 'human' }).ok).toBe(false)
  })

  it('I8 — RUNNING exige lease valido da propria tentativa', () => {
    const att = attemptId('att-1')
    expect(checkRunningHasLease({ status: 'READY' }).ok).toBe(true)
    expect(checkRunningHasLease({ status: 'RUNNING' }).ok).toBe(false)
    expect(
      checkRunningHasLease({ status: 'RUNNING', lease: { attemptId: att, valid: false } }).ok,
    ).toBe(false)
    expect(
      checkRunningHasLease({
        status: 'RUNNING',
        lease: { attemptId: att, valid: true },
        currentAttemptId: attemptId('att-2'),
      }).ok,
    ).toBe(false)
    expect(
      checkRunningHasLease({
        status: 'RUNNING',
        lease: { attemptId: att, valid: true },
        currentAttemptId: att,
      }).ok,
    ).toBe(true)
  })

  it('I9 — nenhum despacho excede maxConcurrent do provider', () => {
    expect(checkProviderCapacity(capacity(2, 3), providerId('p-alpha')).ok).toBe(true)
    expect(checkProviderCapacity(capacity(4, 3), providerId('p-alpha')).ok).toBe(false)
    expect(checkProviderCapacity(capacity(1, 3), providerId('p-beta')).ok).toBe(false)
  })

  it('I10 — cross-provider-required nunca rebaixa; preferred so com evento', () => {
    expect(
      checkPolicyNotSilentlyDowngraded({
        policy: 'cross-provider-required',
        policyOutcome: 'downgraded',
      }).ok,
    ).toBe(false)
    expect(
      checkPolicyNotSilentlyDowngraded({
        policy: 'cross-provider-preferred',
        policyOutcome: 'downgraded',
      }).ok,
    ).toBe(false)
    expect(
      checkPolicyNotSilentlyDowngraded({
        policy: 'cross-provider-preferred',
        policyOutcome: 'downgraded',
        downgradeEventEmitted: true,
      }).ok,
    ).toBe(true)
    expect(
      checkPolicyNotSilentlyDowngraded({
        policy: 'cross-provider-required',
        policyOutcome: 'satisfied',
      }).ok,
    ).toBe(true)
  })

  it('I11 — o processo do agente inicia na worktree da tentativa', () => {
    expect(checkAgentCwd({ cwd: '/wt/a1', worktreePath: '/wt/a1' }).ok).toBe(true)
    expect(checkAgentCwd({ cwd: '/repo', worktreePath: '/wt/a1' }).ok).toBe(false)
  })

  it('violations filtra apenas o que foi violado', () => {
    const resultados = [
      checkAttemptBudget({ attemptCount: 1, maxAttempts: 3 }),
      checkAttemptBudget({ attemptCount: 9, maxAttempts: 3 }),
    ]
    expect(violations(resultados)).toHaveLength(1)
  })
})
