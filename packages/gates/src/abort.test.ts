import { afterAll, describe, expect, it } from 'vitest'
import {
  cleanupWorkspaces,
  ENV_ALLOW,
  envSource,
  makeGate,
  makeWorkspace,
  nodeCommand,
  RUN_ID,
} from './__fixtures__/gate-fixtures.js'
import { GateRunner } from './runner.js'

/**
 * Gate cancelado pelo encerramento do control plane (STABILITY-SLICE-004).
 *
 * Um gate de dez minutos nao pode segurar o encerramento por dez minutos, e o resultado
 * dele seria descartado de qualquer forma. O comando em voo recebe SIGTERM (depois SIGKILL)
 * e os seguintes nem comecam — registrados como nao medidos, com a razao certa.
 */

afterAll(async () => {
  await cleanupWorkspaces()
})

describe('GateRunRequest.signal', () => {
  it('cancela o comando em voo e marca os seguintes como ABORTED', async () => {
    const workspace = await makeWorkspace()
    const controller = new AbortController()
    const gate = makeGate([
      { run: nodeCommand('setTimeout(() => {}, 30000)') },
      { run: nodeCommand('process.exit(0)') },
    ])
    const inicio = Date.now()
    const pending = new GateRunner({ envSource: envSource() }).run({
      gate,
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort('encerrando'), 150)
    const result = await pending

    expect(Date.now() - inicio).toBeLessThan(10_000)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.exitCode).toBeNull()
    expect(result.skipped).toEqual([
      expect.objectContaining({ index: 1, reason: 'ABORTED', after: 0 }),
    ])
    expect(result.status).not.toBe('PASS')
  })

  it('sinal ja abortado: nenhum comando roda', async () => {
    const workspace = await makeWorkspace()
    const controller = new AbortController()
    controller.abort()
    const result = await new GateRunner({ envSource: envSource() }).run({
      gate: makeGate([{ run: nodeCommand('process.exit(0)') }]),
      scope: 'mission',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
      signal: controller.signal,
    })
    expect(result.results).toHaveLength(0)
    expect(result.skipped).toEqual([
      expect.objectContaining({ index: 0, reason: 'ABORTED', after: -1 }),
    ])
  })
})
