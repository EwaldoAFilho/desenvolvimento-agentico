import { describe, expect, it } from 'vitest'
import {
  isRecoverableActiveRunStatus,
  isTerminalRunStatus,
  RECOVERABLE_ACTIVE_RUN_STATUSES,
  RUN_STATUSES,
  type RunStatus,
  TERMINAL_RUN_STATUSES,
} from './run.js'

/**
 * I13 vive ou morre nesta lista. Um estado a mais e o control plane dando dono a um run que
 * espera uma pessoa; um a menos e um run que fica sem quem o faca andar depois de um
 * reinicio. Por isso a regra e enumerada aqui, no dominio, e nao inferida em cada camada.
 */
describe('RECOVERABLE_ACTIVE_RUN_STATUSES', () => {
  it('e exatamente RUNNING, PAUSED, BLOCKED e VERIFYING', () => {
    expect([...RECOVERABLE_ACTIVE_RUN_STATUSES]).toEqual([
      'RUNNING',
      'PAUSED',
      'BLOCKED',
      'VERIFYING',
    ])
  })

  it.each<RunStatus>(['DRAFT', 'APPROVED'])(
    '%s aguarda ato humano e NAO e recuperavel',
    (status) => {
      expect(isRecoverableActiveRunStatus(status)).toBe(false)
    },
  )

  it.each<RunStatus>([...TERMINAL_RUN_STATUSES])('%s e terminal e NAO e recuperavel', (status) => {
    expect(isRecoverableActiveRunStatus(status)).toBe(false)
  })

  it('nenhum estado e recuperavel e terminal ao mesmo tempo', () => {
    for (const status of RUN_STATUSES) {
      expect(isRecoverableActiveRunStatus(status) && isTerminalRunStatus(status)).toBe(false)
    }
  })

  it('cobre todo estado nao terminal que nao aguarda ato humano', () => {
    const aguardamHumano: readonly RunStatus[] = ['DRAFT', 'APPROVED']
    const esperado = RUN_STATUSES.filter(
      (status) => !isTerminalRunStatus(status) && !aguardamHumano.includes(status),
    )
    expect([...RECOVERABLE_ACTIVE_RUN_STATUSES]).toEqual(esperado)
  })
})
