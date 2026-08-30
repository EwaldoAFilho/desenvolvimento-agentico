import { describe, expect, it } from 'vitest'
import { redactSecrets } from './redact.js'

describe('redactSecrets', () => {
  it('mascara token com prefixo sk-', () => {
    const out = redactSecrets('usando sk-abcdEFGH1234567890 agora')
    expect(out).toBe('usando [REDACTED] agora')
  })

  it('mascara token pessoal com prefixo ghp_', () => {
    const out = redactSecrets('remote: ghp_ABCdef0123456789ABCdef0123456789ABCD')
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('ghp_ABCdef')
  })

  it('mascara o valor de um cabecalho Bearer preservando o esquema', () => {
    const out = redactSecrets('Authorization: Bearer eyJhbGciOi.JIUzI1NiJ9.abcdefgh')
    expect(out).toBe('Authorization: Bearer [REDACTED]')
  })

  it('mascara access key id da nuvem', () => {
    expect(redactSecrets('id=AKIAIOSFODNN7EXAMPLE')).toBe('id=[REDACTED]')
  })

  it('mascara atribuicao cujo nome contem TOKEN', () => {
    expect(redactSecrets('GITHUB_TOKEN=abc123xyz')).toBe('GITHUB_TOKEN=[REDACTED]')
  })

  it('mascara SECRET, PASSWORD e CREDENTIAL', () => {
    const out = redactSecrets(
      ['MY_SECRET=um-valor', 'db.password = outro', 'AWS_CREDENTIAL:terceiro'].join('\n'),
    )
    expect(out.split('\n')).toEqual([
      'MY_SECRET=[REDACTED]',
      'db.password = [REDACTED]',
      'AWS_CREDENTIAL:[REDACTED]',
    ])
  })

  it('mascara nome em camelCase', () => {
    expect(redactSecrets('apiToken: valor-secreto')).toBe('apiToken: [REDACTED]')
  })

  it('mascara valor entre aspas em JSON', () => {
    expect(redactSecrets('{"apiKey": "abc123def"}')).toBe('{"apiKey": [REDACTED]}')
  })

  it('nao mascara nome que apenas termina em KEY por acidente', () => {
    expect(redactSecrets('MONKEY=banana')).toBe('MONKEY=banana')
  })

  it('nao mascara variaveis inocentes', () => {
    const text = 'PATH=/usr/bin\nHOME=/home/dev\nNODE_ENV=test'
    expect(redactSecrets(text)).toBe(text)
  })

  it('preserva o texto ao redor e a estrutura de linhas', () => {
    const out = redactSecrets('linha 1\nAPI_KEY=segredo\nlinha 3')
    expect(out).toBe('linha 1\nAPI_KEY=[REDACTED]\nlinha 3')
  })

  it('e idempotente', () => {
    const once = redactSecrets('API_KEY=sk-abcdEFGH1234567890')
    expect(redactSecrets(once)).toBe(once)
  })

  it('trata texto vazio', () => {
    expect(redactSecrets('')).toBe('')
  })
})
