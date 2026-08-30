/**
 * Acorda `subscribe` assim que o escritor commita, em vez de esperar o proximo poll. O poll
 * continua existindo: escrita de outro processo nao passa por aqui.
 */
export class ChangeNotifier {
  #waiters: (() => void)[] = []
  #closed = false

  get closed(): boolean {
    return this.#closed
  }

  notify(): void {
    const waiters = this.#waiters
    this.#waiters = []
    for (const resolve of waiters) resolve()
  }

  wait(timeoutMs: number): Promise<void> {
    if (this.#closed) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      // Um subscriber ocioso nao pode segurar o processo vivo.
      timer.unref?.()
      this.#waiters.push(finish)
    })
  }

  close(): void {
    this.#closed = true
    this.notify()
  }
}
