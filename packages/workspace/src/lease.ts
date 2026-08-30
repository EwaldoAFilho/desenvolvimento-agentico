import { WorkspaceBusyError } from './errors.js'

export type BusyPolicy = 'wait' | 'fail'

interface Waiter {
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
  timer?: NodeJS.Timeout
}

/**
 * Um escritor por vez. No modo `shared` o paralelismo de escrita e forcado a 1 (ADR-0007):
 * o segundo `acquire` espera na fila ou falha de forma explicita.
 */
export class WriteGate {
  #held = false
  #waiters: Waiter[] = []

  get held(): boolean {
    return this.#held
  }

  get waiting(): number {
    return this.#waiters.length
  }

  acquire(policy: BusyPolicy = 'wait', timeoutMs?: number): Promise<void> {
    if (!this.#held) {
      this.#held = true
      return Promise.resolve()
    }
    if (policy === 'fail') {
      return Promise.reject(
        new WorkspaceBusyError('arvore compartilhada ja tem um lease de escrita ativo', {
          detail: 'workspace shared aceita um unico escritor (ADR-0007)',
        }),
      )
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject }
      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.#drop(waiter)
          reject(
            new WorkspaceBusyError('espera pelo lease da arvore compartilhada expirou', {
              detail: `timeout de ${timeoutMs}ms`,
            }),
          )
        }, timeoutMs)
        waiter.timer.unref?.()
      }
      this.#waiters.push(waiter)
    })
  }

  release(): void {
    const next = this.#waiters.shift()
    if (next === undefined) {
      this.#held = false
      return
    }
    if (next.timer !== undefined) clearTimeout(next.timer)
    next.resolve()
  }

  #drop(waiter: Waiter): void {
    const index = this.#waiters.indexOf(waiter)
    if (index >= 0) this.#waiters.splice(index, 1)
  }
}

/** Serializa operacoes de git que competem pelo mesmo ref (criar branch, criar worktree). */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn)
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}
