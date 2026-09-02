import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { isProcessGroupAliveError, runCaptured, spawnStreaming } from './runtime.js'
import type { RunSpec } from './types.js'

/**
 * STABILITY-SLICE-004B — o contrato de cancelamento e de assentamento do grupo.
 *
 * `cancel()` promete: resolver SO com o grupo de processos confirmado morto; rejeitar com
 * `PROCESS_GROUP_ALIVE` quando o teto vence com o grupo vivo; e, chamado de novo mais tarde,
 * sondar outra vez. `exit()` promete: relatar a saida do LIDER e, junto, se o GRUPO assentou
 * (`groupTerminated`) — nao importa se a saida veio por cancel, abort, timeout, sinal ou por
 * conta propria. Nenhum caminho sem quem espere (AbortSignal, timeout) pode deixar uma
 * rejeicao orfa: o fato "grupo vivo" sai por `exit()`, nunca por `unhandledRejection` (C1).
 *
 * Um grupo que sobrevive a SIGKILL nao se fabrica de forma portavel: a sonda e injetada.
 */

const NODE = nodeProcess.execPath
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-cancel-contract-')))

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const HANG = 'setTimeout(() => {}, 30000)'
/** Anuncia `pronto` DEPOIS de instalar o tratador: cancelar antes disso seria SIGTERM comum. */
const IGNORES_TERM =
  'process.on("SIGTERM", () => {}); process.stdout.write("pronto\\n"); setInterval(() => {}, 1000)'

async function pronto(running: { stdout(): AsyncIterable<string> }): Promise<void> {
  for await (const line of running.stdout()) {
    if (line.includes('pronto')) return
  }
}

function spec(js: string, extra: Partial<RunSpec> = {}): RunSpec {
  return { command: NODE, args: ['-e', js], cwd: workDir, env: {}, ...extra }
}

/** Grupo "imortal" que o teste controla: `mata()` e a prova de morte chegando. */
function grupo(): { readonly probe: () => boolean; mata(): void; sondas(): number } {
  let vivo = true
  let sondas = 0
  return {
    probe: () => {
      sondas += 1
      return vivo
    },
    mata: () => {
      vivo = false
    },
    sondas: () => sondas,
  }
}

const TETOS = { killGraceMs: 200, groupGraceMs: 150 }

/** Registra toda rejeicao orfa emitida enquanto `work` roda (mais uma folga). */
async function comRejeicoesOrfas<T>(
  work: () => Promise<T>,
): Promise<{ value: T; orfas: unknown[] }> {
  const orfas: unknown[] = []
  const on = (reason: unknown): void => {
    orfas.push(reason)
  }
  nodeProcess.on('unhandledRejection', on)
  try {
    const value = await work()
    await delay(400)
    return { value, orfas }
  } finally {
    nodeProcess.off('unhandledRejection', on)
  }
}

describe('C1 — cancelamento por AbortSignal nunca deixa rejeicao orfa', () => {
  it('abort com grupo vivo: exit() relata groupTerminated=false, zero unhandledRejection, e cancel() depois ainda rejeita', async () => {
    const g = grupo()
    const controller = new AbortController()
    const { value: status, orfas } = await comRejeicoesOrfas(async () => {
      const running = spawnStreaming(spec(HANG, { signal: controller.signal }), {
        ...TETOS,
        probeGroup: g.probe,
      })
      setTimeout(() => controller.abort('control plane encerrando'), 100)
      const status = await running.exit()
      // O residuo continua observavel para quem governa o ciclo de vida: cancel() sonda de
      // novo e rejeita enquanto o grupo existir.
      const erro = await running.cancel('sonda de encerramento').then(
        () => undefined,
        (cause: unknown) => cause,
      )
      expect(isProcessGroupAliveError(erro)).toBe(true)
      return status
    })
    expect(status.cancelled).toBe(true)
    expect(status.cancelReason).toBe('control plane encerrando')
    expect(status.groupTerminated).toBe(false)
    expect(orfas).toEqual([])
  }, 20_000)

  it('abort com grupo morto (sonda real): exit() relata cancelado e groupTerminated=true', async () => {
    const controller = new AbortController()
    const { value: status, orfas } = await comRejeicoesOrfas(async () => {
      const pending = runCaptured(spec(HANG, { signal: controller.signal }), TETOS)
      setTimeout(() => controller.abort('encerrando'), 100)
      return pending
    })
    expect(status.cancelled).toBe(true)
    expect(status.groupTerminated).toBe(true)
    expect(orfas).toEqual([])
  }, 20_000)
})

describe('cancel() — resolve so com o grupo provado morto; rejeita e sonda de novo', () => {
  it('cancel awaited + grupo morto: resolve e exit() diz groupTerminated=true', async () => {
    const running = spawnStreaming(spec(HANG), TETOS)
    await running.cancel('encerrando')
    const status = await running.exit()
    expect(status).toMatchObject({ cancelled: true, groupTerminated: true })
  }, 20_000)

  it('cancel awaited + grupo vivo: rejeita PROCESS_GROUP_ALIVE; provada a morte, o mesmo cancel resolve e exit() passa a dizer groupTerminated=true', async () => {
    const g = grupo()
    const running = spawnStreaming(spec(HANG), { ...TETOS, probeGroup: g.probe })
    const erro = await running.cancel('encerrando').then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(isProcessGroupAliveError(erro)).toBe(true)
    expect((await running.exit()).groupTerminated).toBe(false)
    const antes = g.sondas()

    g.mata()
    await running.cancel('sonda de encerramento')
    // Sondou outra vez — nao repetiu a resposta antiga.
    expect(g.sondas()).toBeGreaterThan(antes)
    expect((await running.exit()).groupTerminated).toBe(true)
  }, 20_000)
})

describe('exit() — saida do lider + assentamento do grupo, em toda forma de saida', () => {
  it('saida natural (exit 0) + descendente vivo alem do teto: code 0 e groupTerminated=false, com o pid do lider', async () => {
    const g = grupo()
    const running = spawnStreaming(spec('process.exit(0)'), { ...TETOS, probeGroup: g.probe })
    const status = await running.exit()
    expect(status).toMatchObject({
      code: 0,
      cancelled: false,
      timedOut: false,
      groupTerminated: false,
    })
    // O grupo e `-pid`: quem guarda o residuo precisa do pid para sondar de novo.
    expect(status.pid).toBe(running.pid)
    expect(typeof status.pid).toBe('number')
  }, 20_000)

  it('saida natural + grupo terminado (sonda real): groupTerminated=true', async () => {
    const status = await runCaptured(spec('process.exit(0)'), TETOS)
    expect(status).toMatchObject({ code: 0, groupTerminated: true })
    expect(typeof status.pid).toBe('number')
  }, 20_000)

  it('timeout + grupo vivo: timedOut=true, groupTerminated=false e nenhuma rejeicao orfa', async () => {
    const g = grupo()
    const { value: status, orfas } = await comRejeicoesOrfas(() =>
      runCaptured(spec(HANG, { timeoutMs: 100 }), { ...TETOS, probeGroup: g.probe }),
    )
    expect(status).toMatchObject({ timedOut: true, cancelled: false, groupTerminated: false })
    expect(orfas).toEqual([])
  }, 20_000)

  it('SIGTERM: lider sai no SIGTERM; grupo vivo -> signal SIGTERM e groupTerminated=false', async () => {
    const g = grupo()
    const running = spawnStreaming(spec(HANG), { ...TETOS, probeGroup: g.probe })
    await running.cancel('encerrando').catch(() => undefined)
    const status = await running.exit()
    expect(status).toMatchObject({ signal: 'SIGTERM', cancelled: true, groupTerminated: false })
  }, 20_000)

  it('SIGKILL: lider ignora SIGTERM; grupo vivo -> signal SIGKILL e groupTerminated=false', async () => {
    const g = grupo()
    const running = spawnStreaming(spec(IGNORES_TERM), { ...TETOS, probeGroup: g.probe })
    await pronto(running)
    await running.cancel('encerrando').catch(() => undefined)
    const status = await running.exit()
    expect(status).toMatchObject({ signal: 'SIGKILL', cancelled: true, groupTerminated: false })
  }, 20_000)

  it('SIGTERM e SIGKILL com sonda real: o grupo assenta e groupTerminated=true', async () => {
    const educado = spawnStreaming(spec(HANG), TETOS)
    await educado.cancel('encerrando')
    expect(await educado.exit()).toMatchObject({ signal: 'SIGTERM', groupTerminated: true })

    const teimoso = spawnStreaming(spec(IGNORES_TERM), TETOS)
    await pronto(teimoso)
    await teimoso.cancel('encerrando')
    expect(await teimoso.exit()).toMatchObject({ signal: 'SIGKILL', groupTerminated: true })
  }, 20_000)

  it('processo que nunca existiu (spawn falhou) nao tem grupo: groupTerminated=true e pid null', async () => {
    const status = await runCaptured(
      { command: join(workDir, 'nao-existe'), args: [], cwd: workDir, env: {} },
      TETOS,
    )
    expect(status.spawnError?.code).toBe('ENOENT')
    expect(status).toMatchObject({ groupTerminated: true, pid: null })
  }, 20_000)
})
