import type { Orchestrator } from '@agentic/orchestrator'
import { describe, expect, it } from 'vitest'
import { superviseForeground } from './foreground.js'

/**
 * Orquestrador de mentira com o minimo que o supervisor toca: `drain()` e `status`. O que
 * esta sob teste e a decisao de FICAR ou SAIR — nao o motor.
 */
class FakeOrchestrator {
  status: string | undefined
  drains = 0
  stops = 0
  /** Quando definido, `drain()` fica pendurado aqui — um run com agente em voo. */
  drainForever = false
  readonly #onDrain: (drains: number) => void

  constructor(status: string | undefined, onDrain: (drains: number) => void = () => undefined) {
    this.status = status
    this.#onDrain = onDrain
  }

  drain(): Promise<void> {
    this.drains += 1
    this.#onDrain(this.drains)
    if (this.drainForever) return new Promise<void>(() => undefined)
    return Promise.resolve()
  }

  stop(): void {
    this.stops += 1
  }

  get orchestrator(): Orchestrator {
    return this as unknown as Orchestrator
  }
}

const never = (): Promise<void> => new Promise<void>(() => undefined)

describe('supervisao do run em primeiro plano', () => {
  it('run terminado: drena uma vez e encerra', async () => {
    const fake = new FakeOrchestrator('COMPLETED')

    const outcome = await superviseForeground(fake.orchestrator, { waitForShutdown: never })

    expect(outcome).toBe('ended')
    expect(fake.drains).toBe(1)
  })

  it('run sem status conhecido nao segura o processo', async () => {
    const fake = new FakeOrchestrator(undefined)

    expect(await superviseForeground(fake.orchestrator, { waitForShutdown: never })).toBe('ended')
  })

  it('PAUSADO nao e fim: o processo continua no ar ate o resume', async () => {
    // O resume chega por HTTP durante a espera; o supervisor precisa VER a mudanca.
    const fake = new FakeOrchestrator('PAUSED')
    setTimeout(() => {
      fake.status = 'RUNNING'
    }, 15)

    const outcome = await superviseForeground(fake.orchestrator, {
      waitForShutdown: never,
      pollMs: 5,
      onResumed: () => {
        fake.status = 'COMPLETED'
      },
    })

    expect(outcome).toBe('ended')
    // Drenou de novo DEPOIS do resume: retomar volta a despachar.
    expect(fake.drains).toBe(2)
  })

  it('Ctrl+C com trabalho em voo encerra pelo caminho gracioso, sem esperar o run', async () => {
    // Antes, o sinal so era assinado quando o run pausava: com agente, gate ou integracao em
    // voo nao havia tratador, o Node matava o processo e o agente ficava orfao com a posse
    // ja solta pelo SO (I15).
    const fake = new FakeOrchestrator('RUNNING')
    fake.drainForever = true
    const inicio = Date.now()

    const outcome = await superviseForeground(fake.orchestrator, {
      waitForShutdown: () => new Promise((resolve) => setTimeout(resolve, 20)),
    })

    expect(outcome).toBe('shutdown')
    expect(fake.stops).toBe(1)
    expect(Date.now() - inicio).toBeLessThan(5_000)
  })

  it('pausado, Ctrl+C encerra o processo — e so ele', async () => {
    const fake = new FakeOrchestrator('PAUSED')

    const outcome = await superviseForeground(fake.orchestrator, {
      waitForShutdown: () => Promise.resolve(),
      pollMs: 5,
    })

    expect(outcome).toBe('shutdown')
    expect(fake.drains).toBe(1)
  })

  it('`stop` durante a pausa tira o processo do ar pelo fim do run', async () => {
    const fake = new FakeOrchestrator('PAUSED')
    setTimeout(() => {
      fake.status = 'CANCELLED'
    }, 10)

    expect(
      await superviseForeground(fake.orchestrator, { waitForShutdown: never, pollMs: 5 }),
    ).toBe('ended')
    expect(fake.drains).toBe(2)
  })

  it('pausar e retomar duas vezes nao encerra o processo no meio', async () => {
    const fake = new FakeOrchestrator('PAUSED')
    const pauses: number[] = []

    const outcome = await superviseForeground(fake.orchestrator, {
      waitForShutdown: never,
      pollMs: 5,
      onPaused: () => {
        pauses.push(fake.drains)
        setTimeout(() => {
          fake.status = 'RUNNING'
        }, 5)
      },
      onResumed: () => {
        fake.status = fake.drains >= 2 ? 'COMPLETED' : 'PAUSED'
      },
    })

    expect(outcome).toBe('ended')
    expect(pauses).toEqual([1, 2])
    expect(fake.drains).toBe(3)
  })

  it('avisa o humano ao pausar e ao retomar', async () => {
    const fake = new FakeOrchestrator('PAUSED')
    const notes: string[] = []
    setTimeout(() => {
      fake.status = 'RUNNING'
    }, 10)

    await superviseForeground(fake.orchestrator, {
      waitForShutdown: never,
      pollMs: 5,
      onPaused: () => notes.push('pausado'),
      onResumed: () => {
        notes.push('retomado')
        fake.status = 'FAILED'
      },
    })

    expect(notes).toEqual(['pausado', 'retomado'])
  })
})
