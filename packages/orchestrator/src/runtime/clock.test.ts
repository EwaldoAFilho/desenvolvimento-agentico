import { describe, expect, it } from 'vitest'
import { fixedClock, systemClock } from './clock.js'

describe('systemClock', () => {
  it('devolve o instante corrente', () => {
    const clock = systemClock()
    const delta = Math.abs(clock.now().getTime() - Date.now())
    expect(delta).toBeLessThan(1_000)
  })

  it('tem relogio monotonico que nao anda para tras', () => {
    const clock = systemClock()
    const first = clock.monotonicMs()
    const second = clock.monotonicMs()
    expect(second).toBeGreaterThanOrEqual(first)
  })
})

describe('fixedClock', () => {
  it('congela o tempo por padrao', () => {
    const clock = fixedClock({ start: '2026-03-01T12:00:00.000Z' })
    expect(clock.now().toISOString()).toBe('2026-03-01T12:00:00.000Z')
    expect(clock.now().toISOString()).toBe('2026-03-01T12:00:00.000Z')
  })

  it('avanca um passo por leitura quando configurado', () => {
    const clock = fixedClock({ start: 0, stepMs: 10 })
    expect(clock.now().getTime()).toBe(0)
    expect(clock.now().getTime()).toBe(10)
    expect(clock.monotonicMs()).toBe(20)
  })

  it('aceita avanco e ajuste explicitos', () => {
    const clock = fixedClock({ start: 0 })
    clock.advance(500)
    expect(clock.now().getTime()).toBe(500)
    clock.set('2026-01-02T00:00:00.000Z')
    expect(clock.now().toISOString()).toBe('2026-01-02T00:00:00.000Z')
  })
})
