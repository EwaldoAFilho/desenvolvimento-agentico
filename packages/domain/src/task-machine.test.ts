import { describe, expect, it } from 'vitest'
import {
  doneEvidence,
  EXECUTOR,
  identity,
  NOW,
  RUN,
  T01,
  T02,
  T03,
  taskRun,
} from './__fixtures__/builders.js'
import { InvalidTransitionError } from './errors.js'
import {
  applyTransition,
  canTransition,
  type DispatchReadiness,
  TASK_TRANSITIONS,
  type TaskTransition,
  type TaskTransitionContext,
} from './task-machine.js'
import { createTaskRun, TASK_STATUSES, type TaskStatus } from './task-run.js'

const reviewer = identity('session-reviewer', 'p-beta', 'reviewer')

const DISPATCH_OK: DispatchReadiness = {
  globalSlotAvailable: true,
  executorSlotAvailable: true,
  providerCapacityAvailable: true,
  touchLocksAcquired: true,
  workspaceAcquired: true,
  runStatus: 'RUNNING',
}

/** Contexto que satisfaz toda guarda declarada, para exercitar a tabela inteira. */
const PERMISSIVE: TaskTransitionContext = {
  now: NOW,
  dependencies: [{ taskId: T02, status: 'DONE' }],
  dependents: [{ taskId: T03, status: 'PENDING' }],
  dispatch: DISPATCH_OK,
  review: {
    requireReview: true,
    policy: 'cross-provider-required',
    selection: {
      ok: false,
      policy: 'cross-provider-required',
      reason: 'CROSS_PROVIDER_UNAVAILABLE',
    },
    reviewerSlotAvailable: true,
    providerCapacityAvailable: true,
  },
  reviewResult: {
    verdict: 'PASS',
    reviewer,
    executor: EXECUTOR,
    policy: 'fresh-session',
    policyOutcome: 'satisfied',
  },
  evidence: doneEvidence(),
  retry: { maxAttempts: 3, failure: { code: 'AGENT_ERROR' }, runPaused: false },
  note: 'liberado pelo humano',
  reason: 'motivo',
}

/** Ajusta o contexto para as linhas cujas guardas sao mutuamente exclusivas. */
function contextFor(transition: TaskTransition): TaskTransitionContext {
  if (transition.id === '7') {
    return {
      ...PERMISSIVE,
      review: {
        requireReview: true,
        policy: 'fresh-session',
        selection: {
          ok: true,
          reviewer,
          policy: 'fresh-session',
          effectivePolicy: 'fresh-session',
          policyOutcome: 'satisfied',
        },
        reviewerSlotAvailable: true,
        providerCapacityAvailable: true,
      },
    }
  }
  if (transition.id === '8') {
    return {
      ...PERMISSIVE,
      review: {
        requireReview: false,
        policy: 'fresh-session',
        reviewerSlotAvailable: true,
        providerCapacityAvailable: true,
      },
    }
  }
  if (transition.id === '19') {
    return { ...PERMISSIVE, dependencies: [{ taskId: T02, status: 'RUNNING' }] }
  }
  return PERMISSIVE
}

describe('tabela de transicoes da Task', () => {
  it('nao ha duas linhas com a mesma chave (from, to, trigger)', () => {
    const keys = TASK_TRANSITIONS.map((t) => `${t.from}|${t.to}|${t.trigger}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('cobre as 23 linhas de STATE-MACHINES 1.3, incluindo 12b', () => {
    const ids = new Set(TASK_TRANSITIONS.map((t) => t.id))
    for (let n = 1; n <= 23; n += 1) expect(ids.has(String(n))).toBe(true)
    expect(ids.has('12b')).toBe(true)
  })

  it('a transicao 21 cobre todos os estados nao terminais', () => {
    const cancellable = TASK_TRANSITIONS.filter((t) => t.id === '21').map((t) => t.from)
    expect(cancellable).toHaveLength(9)
    for (const status of TASK_STATUSES) {
      const terminal = status === 'DONE' || status === 'SKIPPED' || status === 'CANCELLED'
      expect(canTransition(status, 'CANCELLED', 'CANCEL_REQUESTED')).toBe(!terminal)
    }
  })

  it.each(
    TASK_TRANSITIONS.filter((t) => t.from !== null).map((t) => [
      `${t.id}: ${t.from} -> ${t.to} via ${t.trigger}`,
      t,
    ]),
  )('aplica %s', (_label, transition) => {
    const from = transition.from as TaskStatus
    const before = taskRun({ status: from, attemptCount: 0 })
    expect(canTransition(from, transition.to, transition.trigger)).toBe(true)
    const after = applyTransition(before, transition, contextFor(transition))
    expect(after.status).toBe(transition.to)
    expect(before.status).toBe(from)
  })
})

describe('transicoes invalidas', () => {
  const invalid: [TaskStatus, TaskStatus, Parameters<typeof canTransition>[2]][] = [
    ['PENDING', 'RUNNING', 'SCHEDULER_DISPATCH'],
    ['READY', 'DONE', 'INTEGRATION_MERGED'],
    ['RUNNING', 'DONE', 'INTEGRATION_MERGED'],
    ['VERIFYING', 'RUNNING', 'SCHEDULER_DISPATCH'],
    ['DONE', 'RUNNING', 'SCHEDULER_DISPATCH'],
    ['SKIPPED', 'READY', 'HUMAN_UNBLOCK'],
    ['CANCELLED', 'READY', 'HUMAN_UNBLOCK'],
    ['REVIEW', 'DONE', 'REVIEW_PASSED'],
    ['RETRY', 'RUNNING', 'SCHEDULER_DISPATCH'],
    ['BLOCKED', 'RUNNING', 'SCHEDULER_DISPATCH'],
  ]

  it.each(invalid)('%s -> %s via %s lanca e nao altera estado', (from, to, trigger) => {
    const before = taskRun({ status: from, attemptCount: 2 })
    expect(() => applyTransition(before, { to, trigger }, PERMISSIVE)).toThrow(
      InvalidTransitionError,
    )
    expect(canTransition(from, to, trigger)).toBe(false)
    expect(before).toEqual(taskRun({ status: from, attemptCount: 2 }))
  })

  it('o erro distingue linha inexistente de guarda reprovada', () => {
    const naoListada = taskRun({ status: 'PENDING' })
    try {
      applyTransition(naoListada, { to: 'RUNNING', trigger: 'SCHEDULER_DISPATCH' })
      expect.unreachable('deveria lancar')
    } catch (error) {
      expect((error as InvalidTransitionError).reason).toBe('NOT_LISTED')
    }

    const guardaReprova = taskRun({ status: 'PENDING' })
    try {
      applyTransition(
        guardaReprova,
        { to: 'READY', trigger: 'DEPENDENCY_SATISFIED' },
        { dependencies: [{ taskId: T02, status: 'FAILED' }] },
      )
      expect.unreachable('deveria lancar')
    } catch (error) {
      const invalidTransition = error as InvalidTransitionError
      expect(invalidTransition.reason).toBe('GUARD_FAILED')
      expect(invalidTransition.guard).toBe('dependencies-satisfied')
    }
    expect(guardaReprova.status).toBe('PENDING')
  })
})

describe('guardas e efeitos', () => {
  it('transicao 1 cria a task em PENDING', () => {
    expect(createTaskRun(RUN, T01)).toMatchObject({ status: 'PENDING', attemptCount: 0 })
    expect(canTransition(null, 'PENDING', 'RUN_CREATED')).toBe(true)
  })

  it('2 registra unblockedBy com as dependencias concluidas', () => {
    const after = applyTransition(
      taskRun({ status: 'PENDING' }),
      { to: 'READY', trigger: 'DEPENDENCY_SATISFIED' },
      {
        now: NOW,
        dependencies: [
          { taskId: T02, status: 'DONE' },
          { taskId: T03, status: 'SKIPPED' },
        ],
      },
    )
    expect(after.unblockedBy).toEqual([T02, T03])
    expect(after.readyAt).toEqual(NOW)
  })

  it('4 exige slot, capacidade do provider, lock e workspace', () => {
    const ready = taskRun({ status: 'READY' })
    for (const key of [
      'globalSlotAvailable',
      'executorSlotAvailable',
      'providerCapacityAvailable',
      'touchLocksAcquired',
      'workspaceAcquired',
    ] as const) {
      const dispatch: DispatchReadiness = { ...DISPATCH_OK, [key]: false }
      expect(() =>
        applyTransition(ready, { to: 'RUNNING', trigger: 'SCHEDULER_DISPATCH' }, { dispatch }),
      ).toThrow(InvalidTransitionError)
    }
    const runPausado: DispatchReadiness = { ...DISPATCH_OK, runStatus: 'PAUSED' }
    expect(() =>
      applyTransition(
        ready,
        { to: 'RUNNING', trigger: 'SCHEDULER_DISPATCH' },
        { dispatch: runPausado },
      ),
    ).toThrow(InvalidTransitionError)
  })

  it('5 consome uma tentativa ao sair de RUNNING', () => {
    const after = applyTransition(
      taskRun({ status: 'RUNNING', attemptCount: 1 }),
      { to: 'VERIFYING', trigger: 'AGENT_COMPLETED' },
      { now: NOW },
    )
    expect(after.attemptCount).toBe(2)
  })

  it('6 com falha de fornecedor nao consome tentativa', () => {
    const semCapacidade = applyTransition(
      taskRun({ status: 'RUNNING', attemptCount: 1 }),
      { to: 'FAILED', trigger: 'ATTEMPT_FAILED' },
      { failure: { code: 'PROVIDER_UNAVAILABLE' } },
    )
    expect(semCapacidade.attemptCount).toBe(1)

    const erroDoAgente = applyTransition(
      taskRun({ status: 'RUNNING', attemptCount: 1 }),
      { to: 'FAILED', trigger: 'ATTEMPT_FAILED' },
      { failure: { code: 'AGENT_ERROR' } },
    )
    expect(erroDoAgente.attemptCount).toBe(2)
  })

  it('7 nao acontece sem revisor que satisfaca a politica', () => {
    expect(() =>
      applyTransition(
        taskRun({ status: 'VERIFYING' }),
        { to: 'REVIEW', trigger: 'GATE_PASSED' },
        {
          review: {
            requireReview: true,
            policy: 'cross-provider-required',
            selection: {
              ok: false,
              policy: 'cross-provider-required',
              reason: 'CROSS_PROVIDER_UNAVAILABLE',
            },
            reviewerSlotAvailable: true,
            providerCapacityAvailable: true,
          },
        },
      ),
    ).toThrow(InvalidTransitionError)
  })

  it('12b leva VERIFYING a BLOCKED por CROSS_PROVIDER_UNAVAILABLE', () => {
    const after = applyTransition(
      taskRun({ status: 'VERIFYING' }),
      { to: 'BLOCKED', trigger: 'REVIEW_POLICY_UNSATISFIABLE' },
      {
        ...PERMISSIVE,
        blockage: {
          kind: 'POLICY',
          reason: 'CROSS_PROVIDER_UNAVAILABLE',
          raisedBy: 'orchestrator',
          raisedAt: NOW,
          needs: 'segundo fornecedor apto a revisar',
        },
      },
    )
    expect(after.status).toBe('BLOCKED')
    expect(after.blockage).toMatchObject({ kind: 'POLICY', reason: 'CROSS_PROVIDER_UNAVAILABLE' })
  })

  it('12b nao dispara quando a politica nao e cross-provider-required', () => {
    expect(() =>
      applyTransition(
        taskRun({ status: 'VERIFYING' }),
        { to: 'BLOCKED', trigger: 'REVIEW_POLICY_UNSATISFIABLE' },
        {
          review: {
            requireReview: true,
            policy: 'cross-provider-preferred',
            selection: {
              ok: false,
              policy: 'cross-provider-preferred',
              reason: 'CROSS_PROVIDER_UNAVAILABLE',
            },
            reviewerSlotAvailable: true,
            providerCapacityAvailable: true,
          },
        },
      ),
    ).toThrow(InvalidTransitionError)
  })

  it('10 recusa revisor igual ao executor', () => {
    expect(() =>
      applyTransition(
        taskRun({ status: 'REVIEW' }),
        { to: 'INTEGRATING', trigger: 'REVIEW_PASSED' },
        {
          reviewResult: {
            verdict: 'PASS',
            reviewer: EXECUTOR,
            executor: EXECUTOR,
            policy: 'fresh-session',
            policyOutcome: 'satisfied',
          },
        },
      ),
    ).toThrow(InvalidTransitionError)
  })

  it('13 exige o predicado P06', () => {
    expect(() =>
      applyTransition(
        taskRun({ status: 'INTEGRATING' }),
        { to: 'DONE', trigger: 'INTEGRATION_MERGED' },
        { evidence: doneEvidence({ integration: 'CONFLICT' }) },
      ),
    ).toThrow(InvalidTransitionError)

    const after = applyTransition(
      taskRun({ status: 'INTEGRATING' }),
      { to: 'DONE', trigger: 'INTEGRATION_MERGED' },
      { now: NOW, evidence: doneEvidence() },
    )
    expect(after.outcome).toMatchObject({ kind: 'DONE' })
    expect(after.finishedAt).toEqual(NOW)
  })

  it('15 respeita orcamento de tentativas e retentabilidade', () => {
    const esgotado = taskRun({ status: 'FAILED', attemptCount: 3 })
    expect(() =>
      applyTransition(
        esgotado,
        { to: 'RETRY', trigger: 'RETRY_SCHEDULED' },
        { retry: { maxAttempts: 3, failure: { code: 'AGENT_ERROR' }, runPaused: false } },
      ),
    ).toThrow(InvalidTransitionError)

    const naoRetentavel = taskRun({ status: 'FAILED', attemptCount: 1 })
    expect(() =>
      applyTransition(
        naoRetentavel,
        { to: 'RETRY', trigger: 'RETRY_SCHEDULED' },
        { retry: { maxAttempts: 3, failure: { code: 'PROVIDER_NOT_READY' }, runPaused: false } },
      ),
    ).toThrow(InvalidTransitionError)

    const pausado = taskRun({ status: 'FAILED', attemptCount: 1 })
    expect(() =>
      applyTransition(
        pausado,
        { to: 'RETRY', trigger: 'RETRY_SCHEDULED' },
        { retry: { maxAttempts: 3, failure: { code: 'AGENT_ERROR' }, runPaused: true } },
      ),
    ).toThrow(InvalidTransitionError)
  })

  it('15 aceita SCOPE_VIOLATION na primeira ocorrencia e recusa na segunda', () => {
    const falhou = taskRun({ status: 'FAILED', attemptCount: 1 })
    const primeira = applyTransition(
      falhou,
      { to: 'RETRY', trigger: 'RETRY_SCHEDULED' },
      {
        retry: {
          maxAttempts: 3,
          failure: { code: 'SCOPE_VIOLATION' },
          retryContext: { scopeViolationCount: 1 },
          runPaused: false,
        },
      },
    )
    expect(primeira.status).toBe('RETRY')
    expect(() =>
      applyTransition(
        falhou,
        { to: 'RETRY', trigger: 'RETRY_SCHEDULED' },
        {
          retry: {
            maxAttempts: 3,
            failure: { code: 'SCOPE_VIOLATION' },
            retryContext: { scopeViolationCount: 2 },
            runPaused: false,
          },
        },
      ),
    ).toThrow(InvalidTransitionError)
  })

  it('18 exige nota humana; 19 e o caminho com deps pendentes', () => {
    const bloqueada = taskRun({ status: 'BLOCKED' })
    expect(() =>
      applyTransition(bloqueada, { to: 'READY', trigger: 'HUMAN_UNBLOCK' }, { note: '   ' }),
    ).toThrow(InvalidTransitionError)

    const liberada = applyTransition(
      bloqueada,
      { to: 'READY', trigger: 'HUMAN_UNBLOCK' },
      { now: NOW, note: 'decisao arquitetural registrada' },
    )
    expect(liberada.status).toBe('READY')

    const aindaPendente = applyTransition(
      bloqueada,
      { to: 'PENDING', trigger: 'HUMAN_UNBLOCK' },
      { dependencies: [{ taskId: T02, status: 'RUNNING' }] },
    )
    expect(aindaPendente.status).toBe('PENDING')
  })

  it('23 reabre DONE apenas se nenhum dependente saiu de PENDING/READY/BLOCKED', () => {
    const concluida = taskRun({ status: 'DONE', finishedAt: NOW })
    const reaberta = applyTransition(
      concluida,
      { to: 'READY', trigger: 'HUMAN_REOPEN' },
      { now: NOW, dependents: [{ taskId: T03, status: 'BLOCKED' }], reason: 'contrato mudou' },
    )
    expect(reaberta.status).toBe('READY')
    expect(reaberta.finishedAt).toBeUndefined()
    expect(reaberta.outcome).toBeUndefined()

    for (const status of ['RUNNING', 'VERIFYING', 'REVIEW', 'INTEGRATING', 'DONE'] as const) {
      expect(() =>
        applyTransition(
          concluida,
          { to: 'READY', trigger: 'HUMAN_REOPEN' },
          { dependents: [{ taskId: T03, status }] },
        ),
      ).toThrow(InvalidTransitionError)
    }
  })

  it('sem `now` no contexto, nenhum carimbo de tempo e inventado', () => {
    const after = applyTransition(
      taskRun({ status: 'INTEGRATING' }),
      { to: 'DONE', trigger: 'INTEGRATION_MERGED' },
      { evidence: doneEvidence() },
    )
    expect(after.finishedAt).toBeUndefined()
  })
})
