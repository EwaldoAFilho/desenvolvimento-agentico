import { providerId } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import { CapacityBook, slotFor } from './capacity.js'

const ALFA = providerId('alfa')
const BETA = providerId('beta')

describe('CapacityBook', () => {
  it('conta por provider e recusa alem do maxConcurrent (I9)', () => {
    const book = new CapacityBook({ alfa: 2 })
    expect(book.acquire(ALFA, 'executor').ok).toBe(true)
    expect(book.acquire(ALFA, 'reviewer').ok).toBe(true)
    const negado = book.acquire(ALFA, 'executor')
    expect(negado.ok).toBe(false)
    if (negado.ok) return
    expect(negado.reason).toBe('AT_CAPACITY')
    expect(negado.capacity).toBe(2)
  })

  it('a vaga e a mesma para execucao e revisao', () => {
    const book = new CapacityBook({ alfa: 1 })
    book.acquire(ALFA, 'executor')
    expect(book.acquire(ALFA, 'reviewer').ok).toBe(false)
  })

  it('provider nao declarado e recusado como UNKNOWN_PROVIDER', () => {
    const negado = new CapacityBook({ alfa: 1 }).acquire(BETA, 'executor')
    expect(negado.ok).toBe(false)
    if (negado.ok) return
    expect(negado.reason).toBe('UNKNOWN_PROVIDER')
    expect(negado.capacity).toBeNull()
  })

  it('liberar devolve a vaga e a contagem por papel', () => {
    const book = new CapacityBook({ alfa: 1 })
    book.acquire(ALFA, 'reviewer')
    expect(book.snapshot().reviewer.active).toBe(1)
    expect(book.release(ALFA, 'reviewer').ok).toBe(true)
    expect(book.snapshot().reviewer.active).toBe(0)
    expect(book.acquire(ALFA, 'executor').ok).toBe(true)
  })

  it('liberar o que nao esta em uso e recusado, sem contagem negativa', () => {
    const book = new CapacityBook({ alfa: 1 })
    const recusa = book.release(ALFA, 'executor')
    expect(recusa.ok).toBe(false)
    expect(book.snapshot().executor.active).toBe(0)
  })

  it('sem tetos declarados, o teto global vira a soma das capacidades', () => {
    const snapshot = new CapacityBook({ alfa: 3, beta: 2 }).snapshot()
    expect(snapshot.global.maxParallelTasks).toBe(5)
    expect(snapshot.executor.max).toBe(5)
    expect(snapshot.reviewer.max).toBe(5)
  })

  it('tetos informados prevalecem sobre a soma', () => {
    const book = new CapacityBook(
      { alfa: 3, beta: 2 },
      { maxParallelTasks: 5, maxExecutors: 4, maxReviewers: 2 },
    )
    expect(book.limits).toEqual({ maxParallelTasks: 5, maxExecutors: 4, maxReviewers: 2 })
  })

  it('snapshot e um retrato novo: mutar o resultado nao altera a conta', () => {
    const book = new CapacityBook({ alfa: 2 })
    const primeiro = book.snapshot()
    const entrada = primeiro.byProvider.alfa
    if (entrada !== undefined) (entrada as { running: number }).running = 99
    expect(book.snapshot().byProvider.alfa?.running).toBe(0)
  })

  it('usage responde running e capacity conhecidos', () => {
    const book = new CapacityBook({ alfa: 2 })
    book.acquire(ALFA, 'executor')
    expect(book.usage(ALFA)).toEqual({ running: 1, capacity: 2 })
    expect(book.usage(BETA)).toEqual({ running: 0, capacity: null })
  })

  it('o papel do agente vem do tipo do assignment', () => {
    expect(slotFor('execute')).toBe('executor')
    expect(slotFor('review')).toBe('reviewer')
  })
})
