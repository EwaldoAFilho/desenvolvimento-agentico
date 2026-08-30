import { describe, expect, it } from 'vitest'
import { NOW, run, T01, T02, T03 } from './__fixtures__/builders.js'
import { InvalidTransitionError } from './errors.js'
import { RUN_STATUSES, type RunStatus } from './run.js'
import {
  applyRunTransition,
  canRunTransition,
  checkRunCompletion,
  deriveRunStatus,
  isRunDeadlocked,
  isRunReadyToVerify,
  RUN_TRANSITIONS,
  type RunTransitionContext,
  type TaskRunSnapshot,
} from './run-machine.js'

const APPROVAL = { actor: 'humano', at: NOW }

function tasks(...statuses: TaskRunSnapshot['status'][]): TaskRunSnapshot[] {
  const ids = [T01, T02, T03]
  return statuses.map((status, index) => ({ taskId: ids[index] ?? T01, status }))
}

const COMPLETABLE: RunTransitionContext = {
  now: NOW,
  tasks: tasks('DONE', 'SKIPPED'),
  approval: APPROVAL,
  missionGateStatus: 'PASS',
  integrationConsolidated: true,
  warningsAccepted: true,
}

describe('estados derivados do Run', () => {
  it('BLOCKED quando nada progride e ha task BLOCKED', () => {
    expect(isRunDeadlocked(tasks('BLOCKED', 'DONE'))).toBe(true)
    expect(isRunDeadlocked(tasks('BLOCKED', 'READY'))).toBe(false)
    expect(isRunDeadlocked(tasks('BLOCKED', 'RETRY'))).toBe(false)
    expect(isRunDeadlocked(tasks('DONE', 'SKIPPED'))).toBe(false)
  })

  it('PENDING sozinho nao conta como progresso (deadlock de dependencia)', () => {
    expect(isRunDeadlocked(tasks('BLOCKED', 'PENDING'))).toBe(true)
  })

  it('VERIFYING quando todas encerradas e ao menos uma DONE', () => {
    expect(isRunReadyToVerify(tasks('DONE', 'SKIPPED', 'CANCELLED'))).toBe(true)
    expect(isRunReadyToVerify(tasks('SKIPPED', 'CANCELLED'))).toBe(false)
    expect(isRunReadyToVerify(tasks('DONE', 'RUNNING'))).toBe(false)
    expect(isRunReadyToVerify([])).toBe(false)
  })

  it('uma task CANCELLED impede COMPLETED', () => {
    const check = checkRunCompletion({ ...COMPLETABLE, tasks: tasks('DONE', 'CANCELLED') })
    expect(check).toMatchObject({ ok: false, reason: 'CANCELLED_TASK_PRESENT' })
  })

  it('COMPLETED exige mission gate PASS e branch consolidada', () => {
    expect(checkRunCompletion(COMPLETABLE)).toEqual({ ok: true })
    expect(checkRunCompletion({ ...COMPLETABLE, missionGateStatus: 'FAIL' })).toMatchObject({
      ok: false,
      reason: 'MISSION_GATE_NOT_PASSED',
    })
    expect(checkRunCompletion({ ...COMPLETABLE, integrationConsolidated: false })).toMatchObject({
      ok: false,
      reason: 'INTEGRATION_NOT_CONSOLIDATED',
    })
    expect(checkRunCompletion({ ...COMPLETABLE, tasks: tasks('SKIPPED') })).toMatchObject({
      ok: false,
      reason: 'NO_TASK_DONE',
    })
  })

  it('deriveRunStatus sugere o estado derivado a cada tick', () => {
    expect(deriveRunStatus('RUNNING', { tasks: tasks('BLOCKED', 'PENDING') })).toBe('BLOCKED')
    expect(deriveRunStatus('RUNNING', { tasks: tasks('DONE', 'SKIPPED') })).toBe('VERIFYING')
    expect(deriveRunStatus('RUNNING', { tasks: tasks('RUNNING') })).toBeUndefined()
    expect(deriveRunStatus('BLOCKED', { tasks: tasks('READY', 'BLOCKED') })).toBe('RUNNING')
    expect(deriveRunStatus('VERIFYING', COMPLETABLE)).toBe('COMPLETED')
  })
})

describe('tabela de transicoes do Run', () => {
  it('nao ha duas linhas com a mesma chave', () => {
    const keys = RUN_TRANSITIONS.map((t) => `${t.from}|${t.to}|${t.trigger}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('cancelamento cobre todo estado nao terminal', () => {
    for (const status of RUN_STATUSES) {
      const terminal = status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED'
      expect(canRunTransition(status, 'CANCELLED', 'CANCEL_REQUESTED')).toBe(!terminal)
    }
  })

  it('DRAFT -> APPROVED exige compilacao sem ERROR e aprovacao humana', () => {
    const draft = run({ status: 'DRAFT' })
    expect(() =>
      applyRunTransition(
        draft,
        { to: 'APPROVED', trigger: 'HUMAN_APPROVED' },
        { approval: APPROVAL, diagnostics: [{ severity: 'ERROR' }] },
      ),
    ).toThrow(InvalidTransitionError)
    expect(() =>
      applyRunTransition(draft, { to: 'APPROVED', trigger: 'HUMAN_APPROVED' }, { diagnostics: [] }),
    ).toThrow(InvalidTransitionError)

    const aprovado = applyRunTransition(
      draft,
      { to: 'APPROVED', trigger: 'HUMAN_APPROVED' },
      { approval: APPROVAL, diagnostics: [{ severity: 'WARNING' }] },
    )
    expect(aprovado.status).toBe('APPROVED')
    expect(aprovado.approvedAt).toEqual(NOW)
    expect(draft.status).toBe('DRAFT')
  })

  it('APPROVED -> RUNNING exige aceite explicito quando ha WARNING', () => {
    const aprovado = run({ status: 'APPROVED' })
    expect(() =>
      applyRunTransition(
        aprovado,
        { to: 'RUNNING', trigger: 'RUN_STARTED' },
        { diagnostics: [{ severity: 'WARNING' }] },
      ),
    ).toThrow(InvalidTransitionError)

    const iniciado = applyRunTransition(
      aprovado,
      { to: 'RUNNING', trigger: 'RUN_STARTED' },
      { now: NOW, diagnostics: [{ severity: 'WARNING' }], warningsAccepted: true },
    )
    expect(iniciado.status).toBe('RUNNING')
    expect(iniciado.startedAt).toEqual(NOW)
  })

  it('RUNNING <-> PAUSED', () => {
    const pausado = applyRunTransition(run({ status: 'RUNNING' }), {
      to: 'PAUSED',
      trigger: 'HUMAN_PAUSE',
    })
    expect(pausado.status).toBe('PAUSED')
    expect(applyRunTransition(pausado, { to: 'RUNNING', trigger: 'HUMAN_RESUME' }).status).toBe(
      'RUNNING',
    )
  })

  it('VERIFYING -> COMPLETED so com o predicado da missao satisfeito', () => {
    const verificando = run({ status: 'VERIFYING' })
    expect(() =>
      applyRunTransition(
        verificando,
        { to: 'COMPLETED', trigger: 'MISSION_GATE_PASSED' },
        { ...COMPLETABLE, tasks: tasks('DONE', 'CANCELLED') },
      ),
    ).toThrow(InvalidTransitionError)

    const concluido = applyRunTransition(
      verificando,
      { to: 'COMPLETED', trigger: 'MISSION_GATE_PASSED' },
      COMPLETABLE,
    )
    expect(concluido.status).toBe('COMPLETED')
    expect(concluido.finishedAt).toEqual(NOW)
  })

  it('run com task CANCELLED termina FAILED', () => {
    const falho = applyRunTransition(
      run({ status: 'VERIFYING' }),
      { to: 'FAILED', trigger: 'RUN_NOT_COMPLETABLE' },
      { ...COMPLETABLE, tasks: tasks('DONE', 'CANCELLED'), reason: 'task cancelada' },
    )
    expect(falho.status).toBe('FAILED')
    expect(falho.failureReason).toBe('task cancelada')
  })

  it('BLOCKED -> RUNNING so quando o deadlock acabou', () => {
    const bloqueado = run({ status: 'BLOCKED' })
    expect(() =>
      applyRunTransition(
        bloqueado,
        { to: 'RUNNING', trigger: 'TASK_UNBLOCKED' },
        { tasks: tasks('BLOCKED', 'PENDING') },
      ),
    ).toThrow(InvalidTransitionError)
    expect(
      applyRunTransition(
        bloqueado,
        { to: 'RUNNING', trigger: 'TASK_UNBLOCKED' },
        { tasks: tasks('BLOCKED', 'READY') },
      ).status,
    ).toBe('RUNNING')
  })

  it.each<[RunStatus, RunStatus, 'RUN_STARTED' | 'MISSION_GATE_PASSED' | 'HUMAN_RESUME']>([
    ['DRAFT', 'RUNNING', 'RUN_STARTED'],
    ['RUNNING', 'COMPLETED', 'MISSION_GATE_PASSED'],
    ['COMPLETED', 'RUNNING', 'HUMAN_RESUME'],
    ['CANCELLED', 'RUNNING', 'HUMAN_RESUME'],
  ])('%s -> %s via %s nao existe na tabela', (from, to, trigger) => {
    const antes = run({ status: from })
    expect(canRunTransition(from, to, trigger)).toBe(false)
    expect(() => applyRunTransition(antes, { to, trigger }, COMPLETABLE)).toThrow(
      InvalidTransitionError,
    )
    expect(antes.status).toBe(from)
  })
})
