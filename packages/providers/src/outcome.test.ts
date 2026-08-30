import type { ExitStatus } from '@agentic/domain'
import { providerId } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import { executeAssignment } from './__fixtures__/assignments.js'
import {
  cancelReasonOf,
  claimsFromOutput,
  logsRefFor,
  MAX_CLAIM_SUMMARY_CHARS,
  outcomeStatusFromExit,
  runStatusFor,
  spawnErrorOf,
} from './outcome.js'

function exit(overrides: Partial<ExitStatus> = {}): ExitStatus {
  return { code: 0, signal: null, timedOut: false, cancelled: false, durationMs: 10, ...overrides }
}

describe('outcomeStatusFromExit — o processo decide, nao o agente (P05)', () => {
  it('codigo zero vira completed', () => {
    expect(outcomeStatusFromExit(exit())).toBe('completed')
  })

  it('codigo diferente de zero vira failed', () => {
    expect(outcomeStatusFromExit(exit({ code: 7 }))).toBe('failed')
  })

  it('codigo nulo (morto por sinal) vira failed', () => {
    expect(outcomeStatusFromExit(exit({ code: null, signal: 'SIGSEGV' }))).toBe('failed')
  })

  it('timeout tem status proprio, mesmo com codigo de saida', () => {
    expect(outcomeStatusFromExit(exit({ code: 1, timedOut: true }))).toBe('timeout')
  })

  it('cancelamento vence timeout: quem mandou parar fomos nos', () => {
    expect(outcomeStatusFromExit(exit({ code: null, timedOut: true, cancelled: true }))).toBe(
      'cancelled',
    )
  })
})

describe('runStatusFor', () => {
  it('mapeia o resultado para o estado do handle', () => {
    expect(runStatusFor('completed')).toBe('completed')
    expect(runStatusFor('cancelled')).toBe('cancelled')
    expect(runStatusFor('failed')).toBe('failed')
    expect(runStatusFor('timeout')).toBe('failed')
  })
})

describe('claimsFromOutput — relato, nunca fato', () => {
  it('resume pela ultima linha util de stdout', () => {
    const claims = claimsFromOutput(['inicio', 'meio', 'terminei a task', '  '], [], exit())
    expect(claims.summary).toBe('terminei a task')
    expect(claims.detail).toContain('inicio')
  })

  it('cai para stderr quando stdout esta mudo', () => {
    const claims = claimsFromOutput([], ['erro de compilacao'], exit({ code: 1 }))
    expect(claims.summary).toBe('erro de compilacao')
  })

  it('sem saida nenhuma, diz explicitamente que nao houve relato', () => {
    const claims = claimsFromOutput([], [], exit({ code: 3 }))
    expect(claims.summary).toContain('nao produziu relato')
    expect(claims.detail).toBeUndefined()
  })

  it('spawn que falhou aparece no relato', () => {
    const status = exit({ code: null })
    const comFalha = { ...status, spawnError: { code: 'ENOENT', message: 'nao achou' } }
    expect(claimsFromOutput([], [], comFalha).summary).toContain('ENOENT')
    expect(spawnErrorOf(comFalha)?.code).toBe('ENOENT')
  })

  it('trunca resumo enorme em vez de carregar o log inteiro', () => {
    const gigante = 'x'.repeat(MAX_CLAIM_SUMMARY_CHARS + 500)
    expect(claimsFromOutput([gigante], [], exit()).summary.length).toBe(MAX_CLAIM_SUMMARY_CHARS + 3)
  })

  it('le o motivo do cancelamento quando o runtime informa', () => {
    const cancelado = { ...exit({ cancelled: true }), cancelReason: 'operador' }
    expect(cancelReasonOf(cancelado)).toBe('operador')
    expect(cancelReasonOf(exit())).toBeUndefined()
  })
})

describe('logsRefFor', () => {
  it('deriva do assignment, entao e estavel e reproduzivel', () => {
    const assignment = executeAssignment('/tmp/ws')
    expect(logsRefFor(providerId('codex'), assignment)).toBe(
      'agent-log:codex/01J0000000000000000000000A/T09/T09-a1',
    )
    expect(logsRefFor(providerId('codex'), assignment)).toBe(
      logsRefFor(providerId('codex'), assignment),
    )
  })
})
