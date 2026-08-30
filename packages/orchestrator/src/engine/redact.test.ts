import { describe, expect, it } from 'vitest'
import { redactLogText } from './redact.js'

describe('redactLogText', () => {
  it('mascara token por prefixo, mesmo sem nome de variavel', () => {
    expect(redactLogText('usando sk-abcdEFGH1234567890 agora')).toBe('usando [REDACTED] agora')
    expect(redactLogText('remote: ghp_ABCdef0123456789ABCdef0123456789ABCD')).toBe(
      'remote: [REDACTED]',
    )
  })

  it('mascara atribuicao com nome sensivel e preserva o resto da linha', () => {
    expect(redactLogText('linha 1\nAPI_KEY=segredo\nlinha 3')).toBe(
      'linha 1\nAPI_KEY=[REDACTED]\nlinha 3',
    )
  })

  it('nao mascara o que apenas parece sensivel', () => {
    expect(redactLogText('MONKEY=banana')).toBe('MONKEY=banana')
  })

  it('e idempotente: aplicar duas vezes nao muda o resultado', () => {
    const once = redactLogText('Authorization: Bearer eyJhbGciOi.JIUzI1NiJ9.abcdefgh')
    expect(redactLogText(once)).toBe(once)
  })
})
