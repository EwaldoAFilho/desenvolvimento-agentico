import { isFailureCode, providerId } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import {
  AgentRuntimeError,
  isAgentRuntimeError,
  ProviderNotReadyError,
  ProviderUnavailableError,
  WorkspaceCwdError,
} from './errors.js'

const ALPHA = providerId('p-alpha')

describe('erros do runtime', () => {
  it('ProviderUnavailableError carrega PROVIDER_UNAVAILABLE', () => {
    const erro = new ProviderUnavailableError(ALPHA, 'executavel ausente')
    expect(erro).toBeInstanceOf(Error)
    expect(erro).toBeInstanceOf(AgentRuntimeError)
    expect(erro.failureCode).toBe('PROVIDER_UNAVAILABLE')
    expect(isFailureCode(erro.failureCode)).toBe(true)
    expect(erro.name).toBe('ProviderUnavailableError')
  })

  it('ProviderNotReadyError carrega PROVIDER_NOT_READY', () => {
    const erro = new ProviderNotReadyError(ALPHA, 'sessao nao autenticada')
    expect(erro.failureCode).toBe('PROVIDER_NOT_READY')
    expect(erro.providerId).toBe(ALPHA)
    expect(erro.message).toContain('sessao nao autenticada')
  })

  it('WorkspaceCwdError carrega WORKSPACE_ERROR e o cwd recusado', () => {
    const erro = new WorkspaceCwdError(ALPHA, '/tmp/nao-existe', 'cwd nao existe')
    expect(erro.failureCode).toBe('WORKSPACE_ERROR')
    expect(erro.cwd).toBe('/tmp/nao-existe')
  })

  it('toFailureReason devolve o motivo pronto para o dominio', () => {
    const erro = new ProviderNotReadyError(ALPHA, 'sem sessao')
    expect(erro.toFailureReason()).toEqual({ code: 'PROVIDER_NOT_READY', detail: 'sem sessao' })
  })

  it('isAgentRuntimeError distingue erro do runtime de erro qualquer', () => {
    expect(isAgentRuntimeError(new ProviderUnavailableError(ALPHA, 'x'))).toBe(true)
    expect(isAgentRuntimeError(new Error('outro'))).toBe(false)
    expect(isAgentRuntimeError('PROVIDER_UNAVAILABLE')).toBe(false)
  })
})
