import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { runCaptured, spawnStreaming } from './runtime.js'
import type { ExitStatus, RunningProcess } from './types.js'

const NODE = nodeProcess.execPath
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-abrupt-')))

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Espera a primeira linha combinada antes de agir sobre o processo. */
async function waitForLine(proc: RunningProcess, marker: string): Promise<void> {
  for await (const line of proc.stdout()) {
    if (line === marker) return
  }
}

const alive = (pid: number | null): boolean => {
  if (pid === null) return false
  try {
    nodeProcess.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('morte abrupta do processo', () => {
  it('SIGKILL externo devolve status classificado, nao excecao nem travamento', async () => {
    const proc = spawnStreaming({
      command: NODE,
      args: ['-e', 'process.stdout.write("vivo\\n"); setInterval(() => {}, 1000)'],
      cwd: workDir,
      env: {},
    })
    await waitForLine(proc, 'vivo')
    const pid = proc.pid
    expect(pid).not.toBeNull()
    nodeProcess.kill(pid ?? 0, 'SIGKILL')

    const status = await proc.exit()
    expect(status.signal).toBe('SIGKILL')
    expect(status.code).toBeNull()
    // O que distingue morte abrupta de timeout e de cancelamento: nenhum dos dois.
    expect(status.timedOut).toBe(false)
    expect(status.cancelled).toBe(false)
    expect(status.spawnError).toBeUndefined()
    expect(status.cancelReason).toBeUndefined()
  }, 20_000)

  it('processo que se mata no meio nao perde a saida ja observada', async () => {
    const result = await runCaptured({
      command: NODE,
      args: [
        '-e',
        'process.stdout.write("passo-1\\npasso-2\\n"); process.stderr.write("aviso\\n"); process.kill(process.pid, "SIGKILL")',
      ],
      cwd: workDir,
      env: {},
    })
    expect(result.signal).toBe('SIGKILL')
    expect(result.code).toBeNull()
    expect(result.stdout).toContain('passo-1')
    expect(result.stdout).toContain('passo-2')
    expect(result.stderr).toContain('aviso')
    expect(result.stdoutTruncated).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  }, 20_000)

  it('linhas emitidas antes do SIGKILL chegam ao assinante e o stream fecha', async () => {
    const proc = spawnStreaming({
      command: NODE,
      args: [
        '-e',
        'process.stdout.write("a\\nb\\n"); setTimeout(() => process.kill(process.pid, "SIGKILL"), 60)',
      ],
      cwd: workDir,
      env: {},
    })
    const lines: string[] = []
    for await (const line of proc.stdout()) lines.push(line)
    expect(lines).toEqual(['a', 'b'])
    expect((await proc.exit()).signal).toBe('SIGKILL')
  }, 20_000)

  it('pai morto com neto segurando os pipes ainda encerra dentro da folga de close', async () => {
    const proc = spawnStreaming(
      {
        command: NODE,
        args: [
          '-e',
          [
            'const cp = require("node:child_process")',
            'cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "inherit" })',
            'process.stdout.write("pai-pronto\\n")',
            'setInterval(() => {}, 1000)',
          ].join(';\n'),
        ],
        cwd: workDir,
        env: {},
      },
      { closeGraceMs: 400 },
    )
    await waitForLine(proc, 'pai-pronto')
    const pid = proc.pid
    nodeProcess.kill(pid ?? 0, 'SIGKILL')

    const started = Date.now()
    const status = await proc.exit()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(status.signal).toBe('SIGKILL')
    expect(status.cancelled).toBe(false)

    // Faxina: o neto sobreviveu ao pai e nao pode vazar para o resto da suite.
    try {
      nodeProcess.kill(-(pid ?? 0), 'SIGKILL')
    } catch {
      // grupo ja encerrado
    }
  }, 20_000)

  it('cancel depois da morte abrupta nao reescreve o status nem trava', async () => {
    const proc = spawnStreaming({
      command: NODE,
      args: ['-e', 'process.stdout.write("vivo\\n"); setInterval(() => {}, 1000)'],
      cwd: workDir,
      env: {},
    })
    await waitForLine(proc, 'vivo')
    nodeProcess.kill(proc.pid ?? 0, 'SIGKILL')
    const first = await proc.exit()

    await proc.cancel('tarde demais')
    const second = await proc.exit()
    expect(second).toBe(first)
    expect(second.cancelled).toBe(false)
    expect(second.signal).toBe('SIGKILL')
  }, 20_000)

  it('o processo morto abruptamente nao fica vivo depois do status', async () => {
    const proc = spawnStreaming({
      command: NODE,
      args: ['-e', 'process.stdout.write("vivo\\n"); setInterval(() => {}, 1000)'],
      cwd: workDir,
      env: {},
    })
    await waitForLine(proc, 'vivo')
    const pid = proc.pid
    nodeProcess.kill(pid ?? 0, 'SIGKILL')
    await proc.exit()
    await delay(100)
    expect(alive(pid)).toBe(false)
  }, 20_000)
})

describe('desfechos de saida sao distinguiveis entre si', () => {
  it('exit != 0, morte por sinal, timeout e cancelamento nao se confundem', async () => {
    const byExitCode = await runCaptured({
      command: NODE,
      args: ['-e', 'process.exit(42)'],
      cwd: workDir,
      env: {},
    })
    const bySignal = await runCaptured({
      command: NODE,
      args: ['-e', 'process.kill(process.pid, "SIGKILL")'],
      cwd: workDir,
      env: {},
    })
    const byTimeout = await runCaptured(
      {
        command: NODE,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: workDir,
        env: {},
        timeoutMs: 250,
      },
      { killGraceMs: 200 },
    )
    const cancelled = spawnStreaming({
      command: NODE,
      args: ['-e', 'process.stdout.write("vivo\\n"); setInterval(() => {}, 1000)'],
      cwd: workDir,
      env: {},
    })
    await waitForLine(cancelled, 'vivo')
    await cancelled.cancel('humano interrompeu')
    const byCancel = await cancelled.exit()

    const shape = (status: ExitStatus): string =>
      `${status.code ?? 'null'}/${status.signal ?? 'null'}/${status.timedOut}/${status.cancelled}`

    expect(byExitCode.code).toBe(42)
    expect(byExitCode.timedOut).toBe(false)
    expect(byExitCode.cancelled).toBe(false)
    expect(bySignal.code).toBeNull()
    expect(bySignal.signal).toBe('SIGKILL')
    expect(byTimeout.timedOut).toBe(true)
    expect(byTimeout.cancelled).toBe(false)
    expect(byCancel.cancelled).toBe(true)
    expect(byCancel.timedOut).toBe(false)
    expect(byCancel.cancelReason).toBe('humano interrompeu')

    const shapes = [byExitCode, bySignal, byTimeout, byCancel].map(shape)
    expect(new Set(shapes).size).toBe(4)
  }, 30_000)
})
