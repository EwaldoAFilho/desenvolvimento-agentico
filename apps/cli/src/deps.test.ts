import nodeProcess from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultDeps } from './deps.js'

/**
 * B3 — segundo Ctrl+C durante o drain.
 *
 * Com tratadores `once`, o primeiro sinal consumia o tratador e o segundo caia no
 * comportamento padrao do Node: processo morto no meio do encerramento, lock solto pelo SO,
 * efeito em voo vivo. A politica passa a ser: o primeiro sinal inicia o encerramento; um
 * sinal durante o encerramento e ABSORVIDO e registrado (nunca mata o processo); se o
 * encerramento falhar e o comando voltar a esperar, esse sinal ja pendente dispara a nova
 * tentativa na hora.
 */

type Listener = (...args: unknown[]) => void
let originais: { readonly SIGINT: Listener[]; readonly SIGTERM: Listener[] }

beforeEach(() => {
  originais = {
    SIGINT: nodeProcess.listeners('SIGINT') as Listener[],
    SIGTERM: nodeProcess.listeners('SIGTERM') as Listener[],
  }
})

afterEach(() => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    nodeProcess.removeAllListeners(signal)
    for (const listener of originais[signal]) nodeProcess.on(signal, listener as never)
  }
})

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

describe('waitForShutdown', () => {
  it('depois do primeiro sinal, o processo CONTINUA com tratador: o segundo nao cai no padrao', async () => {
    const deps = defaultDeps()
    const primeiro = deps.waitForShutdown()
    nodeProcess.emit('SIGINT')
    await primeiro
    // Encerramento em andamento (ninguem esperando): um segundo Ctrl+C nao pode matar o
    // processo — ha tratador registrado para absorve-lo.
    expect(nodeProcess.listenerCount('SIGINT')).toBeGreaterThanOrEqual(1)
    expect(nodeProcess.listenerCount('SIGTERM')).toBeGreaterThanOrEqual(1)
  })

  it('sinal absorvido durante o encerramento dispara a proxima espera na hora (retry)', async () => {
    const deps = defaultDeps()
    const primeiro = deps.waitForShutdown()
    nodeProcess.emit('SIGINT')
    await primeiro
    // Segundo Ctrl+C enquanto o drain acontece: absorvido.
    nodeProcess.emit('SIGINT')
    await tick()
    // O encerramento falhou e o comando volta a esperar: resolve sem novo sinal.
    let resolvido = false
    const segundo = deps.waitForShutdown().then(() => {
      resolvido = true
    })
    await tick()
    expect(resolvido).toBe(true)
    await segundo
  })

  it('sem sinal pendente, a nova espera so resolve com um sinal novo', async () => {
    const deps = defaultDeps()
    const primeiro = deps.waitForShutdown()
    nodeProcess.emit('SIGTERM')
    await primeiro
    let resolvido = false
    const segundo = deps.waitForShutdown().then(() => {
      resolvido = true
    })
    await tick()
    expect(resolvido).toBe(false)
    nodeProcess.emit('SIGTERM')
    await segundo
    expect(resolvido).toBe(true)
  })
})
