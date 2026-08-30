import { describe, expect, it } from 'vitest'
import {
  consumesAttempt,
  FAILURE_CODES,
  type FailureCode,
  isProviderFailure,
  isRetryable,
} from './failure-codes.js'

const RETRYABLE_BY_DEFAULT: FailureCode[] = [
  'AGENT_ERROR',
  'AGENT_TIMEOUT',
  'GATE_FAILED',
  'REVIEW_FAILED',
  'INTEGRATION_CONFLICT',
  'INTERRUPTED',
  'NO_CHANGES',
]

describe('FailureCode', () => {
  it('a uniao tem exatamente os 12 codigos declarados', () => {
    expect(FAILURE_CODES).toHaveLength(12)
    expect(new Set(FAILURE_CODES).size).toBe(12)
  })

  it.each(RETRYABLE_BY_DEFAULT)('%s e retentavel', (code) => {
    expect(isRetryable(code)).toBe(true)
  })

  it('POLICY_VIOLATION nunca e retentavel', () => {
    expect(isRetryable('POLICY_VIOLATION')).toBe(false)
  })

  it('SCOPE_VIOLATION e retentavel na 1a ocorrencia e nao na 2a da mesma task', () => {
    expect(isRetryable('SCOPE_VIOLATION', { scopeViolationCount: 1 })).toBe(true)
    expect(isRetryable('SCOPE_VIOLATION', { scopeViolationCount: 2 })).toBe(false)
    expect(isRetryable('SCOPE_VIOLATION', { scopeViolationCount: 3 })).toBe(false)
    expect(isRetryable('SCOPE_VIOLATION')).toBe(true)
  })

  it('WORKSPACE_ERROR deixa de ser retentavel quando persiste', () => {
    expect(isRetryable('WORKSPACE_ERROR', { workspaceErrorCount: 1 })).toBe(true)
    expect(isRetryable('WORKSPACE_ERROR', { workspaceErrorCount: 2 })).toBe(false)
  })

  it.each<FailureCode>(['PROVIDER_UNAVAILABLE', 'PROVIDER_NOT_READY'])(
    '%s nunca e retentavel e nao consome tentativa',
    (code) => {
      expect(isRetryable(code)).toBe(false)
      expect(isRetryable(code, { scopeViolationCount: 1 })).toBe(false)
      expect(consumesAttempt(code)).toBe(false)
      expect(isProviderFailure(code)).toBe(true)
    },
  )

  it.each(FAILURE_CODES.filter((code) => !code.startsWith('PROVIDER_')))(
    '%s consome tentativa',
    (code) => {
      expect(consumesAttempt(code)).toBe(true)
    },
  )
})
