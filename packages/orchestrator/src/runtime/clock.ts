import { performance } from 'node:perf_hooks'
import type { Clock } from '@agentic/domain'

/** Relogio real. Unico lugar do pacote que consulta o tempo do sistema. */
export function systemClock(): Clock {
  return {
    now: (): Date => new Date(),
    monotonicMs: (): number => performance.now(),
  }
}

export interface FixedClockOptions {
  readonly start?: Date | string | number
  /** Avanco automatico a cada leitura. `0` congela o relogio. */
  readonly stepMs?: number
}

export interface ControllableClock extends Clock {
  advance(ms: number): void
  set(instant: Date | string | number): void
}

/**
 * Relogio de teste: a maquina de estados fica deterministica sem depender do relogio do
 * sistema (ARCHITECTURE 2). `stepMs` produz duracoes observaveis sem esperar de verdade.
 */
export function fixedClock(options: FixedClockOptions = {}): ControllableClock {
  let current = new Date(options.start ?? '2026-01-01T00:00:00.000Z').getTime()
  const step = options.stepMs ?? 0
  const origin = current
  return {
    now: (): Date => {
      const instant = new Date(current)
      current += step
      return instant
    },
    monotonicMs: (): number => current - origin,
    advance: (ms: number): void => {
      current += ms
    },
    set: (instant: Date | string | number): void => {
      current = new Date(instant).getTime()
    },
  }
}
