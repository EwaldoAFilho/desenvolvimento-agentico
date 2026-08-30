import { describe, expect, it } from 'vitest'
import { describeError, failureCodeOf, failureReasonOf, OrchestratorError } from './errors.js'

class RuntimeLike extends Error {
  readonly failureCode = 'PROVIDER_NOT_READY'
}

class WorkspaceLike extends Error {
  readonly code = 'WORKSPACE_ERROR'
}

describe('classificacao de falhas', () => {
  it('usa o codigo declarado pelo runtime de agente', () => {
    expect(failureCodeOf(new RuntimeLike('sem sessao'))).toBe('PROVIDER_NOT_READY')
  })

  it('usa o codigo declarado pelo adapter de workspace', () => {
    expect(failureCodeOf(new WorkspaceLike('worktree suja'))).toBe('WORKSPACE_ERROR')
  })

  it('cai no fallback quando o erro nao se classifica', () => {
    expect(failureCodeOf(new Error('boom'))).toBe('AGENT_ERROR')
    expect(failureCodeOf('texto solto', 'INTERRUPTED')).toBe('INTERRUPTED')
  })

  it('monta FailureReason com detalhe legivel', () => {
    const reason = failureReasonOf(new RuntimeLike('sem sessao'))
    expect(reason).toEqual({ code: 'PROVIDER_NOT_READY', detail: 'sem sessao' })
  })

  it('descreve erro desconhecido sem lancar', () => {
    expect(describeError({ toString: () => 'objeto' })).toBe('objeto')
    expect(describeError(new OrchestratorError('X', 'detalhe'))).toBe('detalhe')
  })
})
