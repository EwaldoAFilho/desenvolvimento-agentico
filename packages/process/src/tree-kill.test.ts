import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { runCaptured, spawnStreaming } from './runtime.js'

const NODE = nodeProcess.execPath
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-treekill-')))

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Pai que gera um neto no mesmo grupo de processos e depois nunca termina sozinho. */
const parentSpawningGrandchild = (grandchildDelayMs: number, parentLifetimeMs: number): string =>
  [
    'const cp = require("node:child_process")',
    `const neto = 'setTimeout(() => { require("node:fs").writeFileSync(process.env.TARGET, "neto") }, ${grandchildDelayMs})'`,
    'cp.spawn(process.execPath, ["-e", neto], { stdio: "ignore", env: process.env })',
    'process.stdout.write("pai-pronto\\n")',
    parentLifetimeMs > 0
      ? `setTimeout(() => {}, ${parentLifetimeMs})`
      : 'setInterval(() => {}, 1000)',
  ].join(';\n')

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('tree-kill', () => {
  it('controle: sem timeout, o neto chega a escrever o arquivo', async () => {
    const target = join(workDir, 'controle.txt')
    const result = await runCaptured({
      command: NODE,
      args: ['-e', parentSpawningGrandchild(200, 1200)],
      cwd: workDir,
      env: { TARGET: target },
    })
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(existsSync(target)).toBe(true)
  }, 20_000)

  it('timeout encerra o pai E o neto: o arquivo nunca aparece', async () => {
    const target = join(workDir, 'neto.txt')
    const result = await runCaptured(
      {
        command: NODE,
        args: ['-e', parentSpawningGrandchild(1500, 0)],
        cwd: workDir,
        env: { TARGET: target },
        timeoutMs: 400,
      },
      { killGraceMs: 300 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.cancelled).toBe(false)
    expect(result.code).toBeNull()
    expect(result.signal).toBe('SIGTERM')
    expect(result.stdout).toContain('pai-pronto')

    await delay(2200)
    expect(existsSync(target)).toBe(false)
  }, 20_000)

  it('cancel encerra o pai E o neto', async () => {
    const target = join(workDir, 'neto-cancelado.txt')
    const proc = spawnStreaming({
      command: NODE,
      args: ['-e', parentSpawningGrandchild(1500, 0)],
      cwd: workDir,
      env: { TARGET: target },
    })
    for await (const line of proc.stdout()) {
      if (line === 'pai-pronto') break
    }
    await proc.cancel('teste de arvore')
    const status = await proc.exit()
    expect(status.cancelled).toBe(true)
    expect(status.timedOut).toBe(false)

    await delay(2200)
    expect(existsSync(target)).toBe(false)
  }, 20_000)

  it('escalona para SIGKILL quando o filho ignora SIGTERM', async () => {
    const result = await runCaptured(
      {
        command: NODE,
        args: [
          '-e',
          'process.on("SIGTERM", () => {}); process.stdout.write("teimoso\\n"); setInterval(() => {}, 1000)',
        ],
        cwd: workDir,
        env: {},
        timeoutMs: 400,
      },
      { killGraceMs: 300 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGKILL')
    expect(result.stdout).toContain('teimoso')
  }, 20_000)

  it('o grupo de processos deixa de existir depois do encerramento', async () => {
    const proc = spawnStreaming({
      command: NODE,
      args: ['-e', 'process.stdout.write("vivo\\n"); setInterval(() => {}, 1000)'],
      cwd: workDir,
      env: {},
    })
    const pid = proc.pid
    expect(pid).not.toBeNull()
    for await (const line of proc.stdout()) {
      if (line === 'vivo') break
    }
    await proc.cancel('fim')
    await delay(300)

    let code: string | null = null
    try {
      nodeProcess.kill(-(pid ?? 0), 0)
    } catch (error) {
      code = error instanceof Error && 'code' in error ? String(error.code) : null
    }
    expect(code).toBe('ESRCH')
  }, 20_000)

  it('timeout nao dispara quando o processo termina antes', async () => {
    const result = await runCaptured({
      command: NODE,
      args: ['-e', 'process.stdout.write("rapido")'],
      cwd: workDir,
      env: {},
      timeoutMs: 5000,
    })
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
  }, 20_000)
})
