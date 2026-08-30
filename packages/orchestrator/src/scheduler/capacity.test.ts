import { describe, expect, it } from 'vitest'
import { ALPHA, BETA, capacity, policies } from './__fixtures__/builders.js'
import { Budget } from './capacity.js'

describe('Budget — os tres tetos em conjunto', () => {
  it('vale o menor teto entre politica e retrato', () => {
    const budget = new Budget(
      policies({ maxExecutors: 5 }),
      capacity({ executor: { max: 1, active: 0 } }),
    )
    expect(budget.reserve('executor', ALPHA)).toBe(true)
    expect(budget.reserve('executor', ALPHA)).toBe(false)
  })

  it('teto global da politica vale mesmo com retrato folgado', () => {
    const budget = new Budget(
      policies({ maxParallelTasks: 1 }),
      capacity({ global: { maxParallelTasks: 9 } }),
    )
    expect(budget.reserve('executor', ALPHA)).toBe(true)
    expect(budget.hasSlot('executor')).toBe(false)
    expect(budget.hasSlot('reviewer')).toBe(false)
  })

  it('maxExecutors da politica vale mesmo com retrato folgado', () => {
    const budget = new Budget(policies({ maxExecutors: 1 }), capacity({ executor: { max: 9 } }))
    expect(budget.reserve('executor', ALPHA)).toBe(true)
    expect(budget.hasSlot('executor')).toBe(false)
  })

  it('maxReviewers da politica vale mesmo com retrato folgado', () => {
    const budget = new Budget(policies({ maxReviewers: 1 }), capacity({ reviewer: { max: 9 } }))
    expect(budget.reserve('reviewer', ALPHA)).toBe(true)
    expect(budget.hasSlot('reviewer')).toBe(false)
  })

  it('teto de revisor do retrato vale mesmo com politica folgada', () => {
    const budget = new Budget(policies({ maxReviewers: 9 }), capacity({ reviewer: { max: 1 } }))
    expect(budget.reserve('reviewer', ALPHA)).toBe(true)
    expect(budget.hasSlot('reviewer')).toBe(false)
  })

  it('teto ja estourado nao vira vaga negativa', () => {
    const budget = new Budget(policies(), capacity({ global: { maxParallelTasks: 2, active: 9 } }))
    expect(budget.hasSlot('executor')).toBe(false)
    expect(budget.hasSlot('reviewer')).toBe(false)
  })

  it('vaga global e compartilhada pelos dois papeis', () => {
    const budget = new Budget(
      policies({ maxParallelTasks: 1 }),
      capacity({ global: { maxParallelTasks: 1 } }),
    )
    expect(budget.reserve('reviewer', ALPHA)).toBe(true)
    expect(budget.hasSlot('executor')).toBe(false)
  })

  it('vaga de executor nao consome vaga de revisor', () => {
    const budget = new Budget(
      policies({ maxExecutors: 1, maxReviewers: 1 }),
      capacity({ executor: { max: 1 }, reviewer: { max: 1 } }),
    )
    expect(budget.reserve('executor', ALPHA)).toBe(true)
    expect(budget.hasSlot('executor')).toBe(false)
    expect(budget.hasSlot('reviewer')).toBe(true)
  })

  it('capacidade de provider e compartilhada entre execucao e revisao', () => {
    const budget = new Budget(
      policies(),
      capacity({ byProvider: { [ALPHA]: { maxConcurrent: 1, running: 0 } } }),
    )
    expect(budget.reserve('executor', ALPHA)).toBe(true)
    expect(budget.hasProvider(ALPHA)).toBe(false)
    expect(budget.reserve('reviewer', ALPHA)).toBe(false)
  })

  it('provider ausente do retrato e indisponivel (I9)', () => {
    const budget = new Budget(
      policies(),
      capacity({ byProvider: { [ALPHA]: { maxConcurrent: 2, running: 0 } } }),
    )
    expect(budget.hasProvider(BETA)).toBe(false)
    expect(budget.reserve('executor', BETA)).toBe(false)
  })

  it('reserva recusada nao consome vaga de nenhum teto', () => {
    const budget = new Budget(
      policies(),
      capacity({ byProvider: { [ALPHA]: { maxConcurrent: 1, running: 1 } } }),
    )
    expect(budget.reserve('executor', ALPHA)).toBe(false)
    expect(budget.hasSlot('executor')).toBe(true)
  })

  it('teto zero nunca libera vaga', () => {
    const budget = new Budget(policies({ maxReviewers: 0 }), capacity({ reviewer: { max: 0 } }))
    expect(budget.hasSlot('reviewer')).toBe(false)
    expect(budget.reserve('reviewer', ALPHA)).toBe(false)
  })
})
