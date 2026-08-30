import { providerId } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import { CapacityLedger } from './capacity.js'

const ALPHA = providerId('p-alpha')
const BETA = providerId('p-beta')
const DESCONHECIDO = providerId('p-nao-configurado')

describe('CapacityLedger', () => {
  it('concede vaga dentro do limite', () => {
    const ledger = new CapacityLedger({ [ALPHA]: 2 })
    const first = ledger.acquire(ALPHA)
    expect(first.ok).toBe(true)
    expect(first.running).toBe(1)
    expect(first.capacity).toBe(2)
  })

  it('concede ate o limite exato', () => {
    const ledger = new CapacityLedger({ [ALPHA]: 2 })
    expect(ledger.acquire(ALPHA).ok).toBe(true)
    const second = ledger.acquire(ALPHA)
    expect(second.ok).toBe(true)
    expect(second.running).toBe(2)
  })

  it('nega alem do limite com falha estruturada, sem lancar', () => {
    const ledger = new CapacityLedger({ [ALPHA]: 1 })
    ledger.acquire(ALPHA)
    const denied = ledger.acquire(ALPHA)
    expect(denied.ok).toBe(false)
    if (denied.ok) throw new Error('esperava negativa')
    expect(denied.reason).toBe('AT_CAPACITY')
    expect(denied.running).toBe(1)
    expect(denied.capacity).toBe(1)
    expect(denied.detail).toContain('sem vaga')
  })

  it('nega provider sem maxConcurrent configurado', () => {
    const ledger = new CapacityLedger({ [ALPHA]: 1 })
    const denied = ledger.acquire(DESCONHECIDO)
    expect(denied.ok).toBe(false)
    if (denied.ok) throw new Error('esperava negativa')
    expect(denied.reason).toBe('UNKNOWN_PROVIDER')
    expect(denied.capacity).toBeNull()
  })

  it('maxConcurrent 0 nunca concede vaga', () => {
    const ledger = new CapacityLedger({ [ALPHA]: 0 })
    const denied = ledger.acquire(ALPHA)
    expect(denied.ok).toBe(false)
    expect(ledger.usage(ALPHA).running).toBe(0)
  })

  it('normaliza limite negativo ou fracionario', () => {
    const ledger = new CapacityLedger({ [ALPHA]: -3, [BETA]: 2.9 })
    expect(ledger.usage(ALPHA).capacity).toBe(0)
    expect(ledger.usage(BETA).capacity).toBe(2)
  })

  it('release devolve a vaga e permite novo acquire', () => {
    const ledger = new CapacityLedger({ [ALPHA]: 1 })
    ledger.acquire(ALPHA)
    expect(ledger.acquire(ALPHA).ok).toBe(false)
    const released = ledger.release(ALPHA)
    expect(released.ok).toBe(true)
    expect(released.running).toBe(0)
    expect(ledger.acquire(ALPHA).ok).toBe(true)
  })

  it('release sem vaga em uso recusa e nao vai a negativo', () => {
    const ledger = new CapacityLedger({ [ALPHA]: 2 })
    const refused = ledger.release(ALPHA)
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('esperava recusa')
    expect(refused.reason).toBe('NOT_HELD')
    expect(ledger.usage(ALPHA).running).toBe(0)
  })

  it('release de provider desconhecido recusa sem lancar', () => {
    const ledger = new CapacityLedger({ [ALPHA]: 2 })
    const refused = ledger.release(DESCONHECIDO)
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('esperava recusa')
    expect(refused.reason).toBe('UNKNOWN_PROVIDER')
  })

  it('snapshot reflete limite e uso de todos os providers configurados', () => {
    const ledger = new CapacityLedger({ [ALPHA]: 3, [BETA]: 1 })
    ledger.acquire(ALPHA)
    ledger.acquire(ALPHA)
    ledger.acquire(BETA)
    expect(ledger.snapshot()).toEqual({
      [ALPHA]: { maxConcurrent: 3, running: 2 },
      [BETA]: { maxConcurrent: 1, running: 1 },
    })
  })

  it('snapshot e copia: mutar o retrato nao altera a conta', () => {
    const ledger = new CapacityLedger({ [ALPHA]: 3 })
    ledger.acquire(ALPHA)
    const snapshot = ledger.snapshot()
    const entry = snapshot[ALPHA]
    if (entry === undefined) throw new Error('provider ausente no retrato')
    ;(entry as { running: number }).running = 99
    expect(ledger.snapshot()[ALPHA]?.running).toBe(1)
  })

  it('providers nao compartilham conta entre si', () => {
    const ledger = new CapacityLedger({ [ALPHA]: 1, [BETA]: 1 })
    expect(ledger.acquire(ALPHA).ok).toBe(true)
    expect(ledger.acquire(BETA).ok).toBe(true)
    expect(ledger.acquire(ALPHA).ok).toBe(false)
  })

  it('execucao e revisao disputam a mesma conta do provider', () => {
    // DOMAIN-MODEL 4.6: capacidade e do provider, nao do papel.
    const ledger = new CapacityLedger({ [ALPHA]: 2 })
    const execucao = ledger.acquire(ALPHA)
    const revisao = ledger.acquire(ALPHA)
    expect(execucao.ok).toBe(true)
    expect(revisao.ok).toBe(true)
    expect(ledger.acquire(ALPHA).ok).toBe(false)
    expect(ledger.usage(ALPHA)).toEqual({ running: 2, capacity: 2 })
    ledger.release(ALPHA)
    expect(ledger.acquire(ALPHA).ok).toBe(true)
  })

  it('usage de provider desconhecido devolve capacity null', () => {
    const ledger = new CapacityLedger()
    expect(ledger.usage(DESCONHECIDO)).toEqual({ running: 0, capacity: null })
  })

  it('ledger sem limites tem retrato vazio', () => {
    expect(new CapacityLedger().snapshot()).toEqual({})
  })
})
