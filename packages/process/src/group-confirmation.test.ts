import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { isProcessGroupAliveError, spawnStreaming } from './runtime.js'

/**
 * B1 — sinal enviado NAO e grupo morto.
 *
 * `kill(-pgid, SIGKILL)` volta antes de o kernel terminar quem estava no meio de uma
 * syscall. Assentar o processo nesse instante deixava o `close` do control plane resolver —
 * e a posse sair — com um descendente ainda capaz de escrever. O runtime passa a SONDAR o
 * grupo ate ele deixar de existir (ESRCH), com teto; vencido o teto, o grupo e declarado
 * VIVO e `cancel()` rejeita, para quem encerra nao fingir que terminou.
 *
 * Um grupo que sobrevive a SIGKILL nao se fabrica de forma portavel; a sonda e injetavel.
 */

const NODE = nodeProcess.execPath
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-group-')))

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

const spec = { command: NODE, args: ['-e', 'setTimeout(() => {}, 30000)'], cwd: workDir, env: {} }

describe('confirmacao da morte do grupo de processos', () => {
  it('grupo confirmado morto: cancel resolve e o status diz groupTerminated=true', async () => {
    let sondas = 0
    const running = spawnStreaming(spec, {
      killGraceMs: 200,
      groupGraceMs: 2_000,
      // Vivo nas duas primeiras sondas, morto depois: a confirmacao ESPEROU.
      probeGroup: () => {
        sondas += 1
        return sondas <= 2
      },
    })
    await running.cancel('encerrando')
    const status = await running.exit()
    expect(status.cancelled).toBe(true)
    expect(status.groupTerminated).toBe(true)
    expect(sondas).toBeGreaterThanOrEqual(3)
  }, 20_000)

  it('grupo que NAO morre dentro do teto: cancel rejeita e o status diz groupTerminated=false', async () => {
    const running = spawnStreaming(spec, {
      killGraceMs: 200,
      groupGraceMs: 300,
      probeGroup: () => true,
    })
    const inicio = Date.now()
    const erro = await running.cancel('encerrando').then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(isProcessGroupAliveError(erro)).toBe(true)
    expect((await running.exit()).groupTerminated).toBe(false)
    // Teto respeitado: nem loop infinito, nem resposta antes da hora.
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(250)
    expect(Date.now() - inicio).toBeLessThan(10_000)
  }, 20_000)

  it('sem sonda injetada, um processo real termina com o grupo confirmado', async () => {
    const running = spawnStreaming(spec, { killGraceMs: 200 })
    await running.cancel('encerrando')
    expect((await running.exit()).groupTerminated).toBe(true)
  }, 20_000)
})
