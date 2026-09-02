import type { Orchestrator } from '@agentic/orchestrator'

/** Intervalo da espera enquanto o run esta pausado. Injetavel para o teste nao dormir. */
export const DEFAULT_PAUSE_POLL_MS = 200

export type ForegroundOutcome = 'ended' | 'shutdown'

export interface ForegroundOptions {
  /**
   * Ctrl+C / SIGTERM. Assinado desde o INICIO: com agente, gate ou integracao em voo, o sinal
   * precisa levar ao encerramento gracioso — sem tratador, o Node mata o processo, o SO
   * solta a posse e o agente (em outro grupo de processos) continua escrevendo (I15).
   */
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
  let stopped = false
  const shutdown = options.waitForShutdown().then(() => {
    stopped = true
  })
  const encerrar = (): ForegroundOutcome => {
    // Desliga o loop; quem chamou encerra o plane pela primitiva de encerramento, que drena
    // e cancela o que estiver em voo. O `drain` pendente termina sozinho quando o
    // orquestrador fechar.
    orchestrator.stop()
    return 'shutdown'
  }

  for (;;) {
    const drained = orchestrator.drain()
    // Se o sinal vencer a corrida, ninguem mais espera este `drain`: a rejeicao dele (se
    // houver) nao pode virar `unhandledRejection`.
    drained.catch(() => undefined)
    const venceu = await Promise.race([
      drained.then(() => 'drained' as const),
      shutdown.then(() => 'shutdown' as const),
    ])
    if (venceu === 'shutdown' || stopped) return encerrar()
    if (orchestrator.status !== 'PAUSED') return 'ended'

    options.onPaused?.()
    // Espera curta e repetida: `resume` chega por HTTP e muda o status do orquestrador.
    while (!stopped && orchestrator.status === 'PAUSED') {
      await Promise.race([shutdown, delay(pollMs)])
    }
    if (stopped) return encerrar()
    options.onResumed?.()
  }
}
