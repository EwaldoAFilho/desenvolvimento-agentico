import { pathScope } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import { T } from './__fixtures__/builders.js'
import { ScopeLedger } from './locks.js'

const scopes = (...raw: string[]) => raw.map(pathScope)

describe('ScopeLedger — sobreposicao de touches (I2)', () => {
  it('caminho identico conflita', () => {
    const ledger = new ScopeLedger([{ taskId: T('T01'), paths: scopes('packages/domain/') }])
    expect(ledger.conflicts(T('T02'), scopes('packages/domain/'))).toBe(true)
  })

  it('diretorio pai conflita com filho', () => {
    const ledger = new ScopeLedger([{ taskId: T('T01'), paths: scopes('packages/') }])
    expect(ledger.conflicts(T('T02'), scopes('packages/domain/src/'))).toBe(true)
  })

  it('arquivo dentro de diretorio bloqueado conflita', () => {
    const ledger = new ScopeLedger([{ taskId: T('T01'), paths: scopes('packages/domain/') }])
    expect(ledger.conflicts(T('T02'), scopes('packages/domain/ids.ts'))).toBe(true)
  })

  it('irmaos nao conflitam', () => {
    const ledger = new ScopeLedger([{ taskId: T('T01'), paths: scopes('packages/domain/') }])
    expect(ledger.conflicts(T('T02'), scopes('packages/graph/'))).toBe(false)
  })

  it('prefixo textual sem fronteira de segmento nao conflita', () => {
    const ledger = new ScopeLedger([{ taskId: T('T01'), paths: scopes('src/a.ts') }])
    expect(ledger.conflicts(T('T02'), scopes('src/a.tsx'))).toBe(false)
  })

  it('basta um par sobreposto entre os conjuntos', () => {
    const ledger = new ScopeLedger([{ taskId: T('T01'), paths: scopes('a/', 'b/') }])
    expect(ledger.conflicts(T('T02'), scopes('c/', 'b/x.ts'))).toBe(true)
  })

  it('lock da propria task e ignorado', () => {
    const ledger = new ScopeLedger([{ taskId: T('T01'), paths: scopes('packages/domain/') }])
    expect(ledger.conflicts(T('T01'), scopes('packages/domain/'))).toBe(false)
  })

  it('escopo vazio nunca conflita', () => {
    const ledger = new ScopeLedger([{ taskId: T('T01'), paths: scopes('packages/') }])
    expect(ledger.conflicts(T('T02'), [])).toBe(false)
  })

  it('reserva da leva corrente passa a bloquear as seguintes', () => {
    const ledger = new ScopeLedger([])
    expect(ledger.conflicts(T('T02'), scopes('packages/domain/'))).toBe(false)
    ledger.reserve(T('T01'), scopes('packages/domain/'))
    expect(ledger.conflicts(T('T02'), scopes('packages/domain/ids.ts'))).toBe(true)
  })

  it('nao muta a lista de locks recebida', () => {
    const locks = [{ taskId: T('T01'), paths: scopes('a/') }]
    const ledger = new ScopeLedger(locks)
    ledger.reserve(T('T02'), scopes('b/'))
    expect(locks).toHaveLength(1)
  })
})
