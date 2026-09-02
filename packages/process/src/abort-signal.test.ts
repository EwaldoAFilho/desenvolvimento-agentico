import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { runCaptured } from './runtime.js'

/**
 * Cancelamento cooperativo por `AbortSignal` (STABILITY-SLICE-004).
 *
 * O encerramento do control plane precisa alcancar processos que ele NAO segura pelo handle
 * — o comando de um gate, o `workspaceSetup` — sem inventar um segundo mecanismo: abortar o
 * sinal e o mesmo `cancel()` de sempre, com o mesmo tree-kill e o mesmo relato.
 */

const NODE = nodeProcess.execPath
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-abort-')))

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('RunSpec.signal', () => {
  it('abortar o sinal cancela o processo em voo e relata o motivo', async () => {
    const controller = new AbortController()
    const inicio = Date.now()
    const pending = runCaptured({
      command: NODE,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: workDir,
      env: {},
      signal: controller.signal,
    })
    setTimeout(() => controller.abort('control plane encerrando'), 100)
    const result = await pending
    expect(result.cancelled).toBe(true)
    expect(result.cancelReason).toBe('control plane encerrando')
    expect(result.code).toBeNull()
    expect(Date.now() - inicio).toBeLessThan(10_000)
  })

  it('sinal JA abortado nao chega a iniciar processo nenhum', async () => {
    const controller = new AbortController()
    controller.abort(new Error('ja encerrado'))
    const result = await runCaptured({
      command: NODE,
      args: [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], "rodou")',
        join(workDir, 'marca'),
      ],
      cwd: workDir,
      env: {},
      signal: controller.signal,
    })
    expect(result.cancelled).toBe(true)
    expect(result.cancelReason).toBe('ja encerrado')
    expect(result.durationMs).toBeLessThan(1_000)
  })

  it('processo que termina antes do abort nao e afetado por ele', async () => {
    const controller = new AbortController()
    const result = await runCaptured({
      command: NODE,
      args: ['-e', 'process.stdout.write("fim")'],
      cwd: workDir,
      env: {},
      signal: controller.signal,
    })
    controller.abort()
    expect(result.cancelled).toBe(false)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('fim')
  })
})
