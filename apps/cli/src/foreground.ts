import type { Orchestrator } from '@agentic/orchestrator'

/** Intervalo da espera enquanto o run esta pausado. Injetavel para o teste nao dormir. */
export const DEFAULT_PAUSE_POLL_MS = 200

export type ForegroundOutcome = 'ended' | 'shutdown'

export interface ForegroundOptions {
  /** Ctrl+C / SIGTERM. So e assinado quando o run pausa: nada de handler ocioso. */
  waitForShutdown(): Promise<void>
  readonly pollMs?: number
  /** Avisa o humano de que o processo ficou no ar de proposito. */
  onPaused?(): void
  onResumed?(): void
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Conduz um run em primeiro plano.
 *
 * `drain` devolve o controle quando nao ha mais nada a fazer AGORA — e isso inclui o run
 * `PAUSED`, que por definicao nao despacha nada novo. Encerrar o processo nesse ponto seria
 * transformar `pause` em `stop`: o control plane sumiria e `resume` nao teria a quem falar.
 *
 * Entao pausado NAO e fim: o processo continua no ar (com a API publicada, se houver),
 * esperando `resume`, o fim do run ou Ctrl+C.
 */
export async function superviseForeground(
  orchestrator: Orchestrator,
  options: ForegroundOptions,
): Promise<ForegroundOutcome> {
  const pollMs = options.pollMs ?? DEFAULT_PAUSE_POLL_MS
  let shutdown: Promise<void> | undefined
  let stopped = false

  for (;;) {
    await orchestrator.drain()
    if (orchestrator.status !== 'PAUSED') return 'ended'

    options.onPaused?.()
    if (shutdown === undefined) {
      shutdown = options.waitForShutdown().then(() => {
        stopped = true
      })
    }
    // Espera curta e repetida: `resume` chega por HTTP e muda o status do orquestrador.
    while (!stopped && orchestrator.status === 'PAUSED') {
      await Promise.race([shutdown, delay(pollMs)])
    }
    if (stopped) return 'shutdown'
    options.onResumed?.()
  }
}
