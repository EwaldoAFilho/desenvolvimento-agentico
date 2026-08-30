import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { spawnStreaming } from './runtime.js'
import type { ChildProcessLike, SpawnFn } from './types.js'

const NODE = nodeProcess.execPath
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-streaming-')))

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const collect = async (source: AsyncIterable<string>): Promise<string[]> => {
  const out: string[] = []
  for await (const line of source) out.push(line)
  return out
}

/** Duble de processo: permite dirigir streams e eventos sem tocar no sistema. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  readonly signals: (NodeJS.Signals | number)[] = []
  pid: number | undefined = 4242

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal ?? 'SIGTERM')
    return true
  }
}

const fakeSpawn =
  (child: FakeChild): SpawnFn =>
  () =>
    child as unknown as ChildProcessLike

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('spawnStreaming', () => {
  it('entrega linhas de stdout incrementalmente, antes do fim do processo', async () => {
    const proc = spawnStreaming({
      command: NODE,
      args: [
        '-e',
        'process.stdout.write("primeira\\n"); setTimeout(() => process.stdout.write("segunda\\n"), 500)',
      ],
      cwd: workDir,
      env: {},
    })
    const start = Date.now()
    const stamps: number[] = []
    const lines: string[] = []
    for await (const line of proc.stdout()) {
      lines.push(line)
      stamps.push(Date.now() - start)
    }
    expect(lines).toEqual(['primeira', 'segunda'])
    expect(stamps[0] ?? Number.POSITIVE_INFINITY).toBeLessThan(400)
    expect(stamps[1] ?? 0).toBeGreaterThanOrEqual(450)
    expect((await proc.exit()).code).toBe(0)
  }, 20_000)

  it('separa as linhas de stderr das de stdout', async () => {
    const proc = spawnStreaming({
      command: NODE,
      args: ['-e', 'process.stdout.write("out-1\\nout-2\\n"); process.stderr.write("err-1\\n")'],
      cwd: workDir,
      env: {},
    })
    const [out, err] = await Promise.all([collect(proc.stdout()), collect(proc.stderr())])
    expect(out).toEqual(['out-1', 'out-2'])
    expect(err).toEqual(['err-1'])
  }, 20_000)

  it('entrega a ultima linha mesmo sem quebra final', async () => {
    const proc = spawnStreaming({
      command: NODE,
      args: ['-e', 'process.stdout.write("a\\nsem-quebra")'],
      cwd: workDir,
      env: {},
    })
    expect(await collect(proc.stdout())).toEqual(['a', 'sem-quebra'])
  }, 20_000)

  it('expoe handle, pid, cwd e startedAt', async () => {
    const before = Date.now()
    const proc = spawnStreaming({
      command: NODE,
      args: ['-e', 'process.stdout.write("x")'],
      cwd: workDir,
      env: {},
    })
    expect(proc.handle).toMatch(/^proc_/)
    expect(proc.pid).toBeGreaterThan(0)
    expect(proc.cwd).toBe(workDir)
    expect(proc.startedAt.getTime()).toBeGreaterThanOrEqual(before)
    await proc.exit()
  }, 20_000)

  it('handles sao distintos entre processos', async () => {
    const spec = { command: NODE, args: ['-e', ''], cwd: workDir, env: {} }
    const a = spawnStreaming(spec)
    const b = spawnStreaming(spec)
    expect(a.handle).not.toBe(b.handle)
    await Promise.all([a.exit(), b.exit()])
  }, 20_000)

  it('cancel marca cancelled e nao timedOut', async () => {
    const proc = spawnStreaming({
      command: NODE,
      args: ['-e', 'process.stdout.write("vivo\\n"); setInterval(() => {}, 1000)'],
      cwd: workDir,
      env: {},
    })
    for await (const line of proc.stdout()) {
      if (line === 'vivo') break
    }
    await proc.cancel('humano pediu parada')
    const status = await proc.exit()
    expect(status.cancelled).toBe(true)
    expect(status.timedOut).toBe(false)
    expect(status.spawnError).toBeUndefined()
    expect(status.cancelReason).toBe('humano pediu parada')
    expect(status.signal).toBe('SIGTERM')
    expect(status.code).toBeNull()
  }, 20_000)

  it('cancel depois do fim natural nao muda o status', async () => {
    const proc = spawnStreaming({
      command: NODE,
      args: ['-e', 'process.stdout.write("fim")'],
      cwd: workDir,
      env: {},
    })
    const first = await proc.exit()
    await proc.cancel('tarde demais')
    const second = await proc.exit()
    expect(second).toBe(first)
    expect(second.cancelled).toBe(false)
    expect(second.code).toBe(0)
  }, 20_000)

  it('exit() e estavel entre chamadas', async () => {
    const proc = spawnStreaming({
      command: NODE,
      args: ['-e', 'process.exitCode = 7'],
      cwd: workDir,
      env: {},
    })
    const [a, b] = await Promise.all([proc.exit(), proc.exit()])
    expect(a).toBe(b)
    expect(a?.code).toBe(7)
  }, 20_000)

  it('assinante tardio recebe as linhas ja emitidas', async () => {
    const proc = spawnStreaming({
      command: NODE,
      args: ['-e', 'process.stdout.write("um\\ndois\\n")'],
      cwd: workDir,
      env: {},
    })
    await proc.exit()
    expect(await collect(proc.stdout())).toEqual(['um', 'dois'])
    expect(await collect(proc.stdout())).toEqual(['um', 'dois'])
  }, 20_000)

  it('dois assinantes simultaneos recebem as mesmas linhas', async () => {
    const proc = spawnStreaming({
      command: NODE,
      args: [
        '-e',
        'process.stdout.write("a\\n"); setTimeout(() => process.stdout.write("b\\n"), 150)',
      ],
      cwd: workDir,
      env: {},
    })
    const [first, second] = await Promise.all([collect(proc.stdout()), collect(proc.stdout())])
    expect(first).toEqual(['a', 'b'])
    expect(second).toEqual(['a', 'b'])
  }, 20_000)

  it('comando inexistente no modo streaming devolve status, nao excecao', async () => {
    const proc = spawnStreaming({
      command: 'agentic-inexistente-streaming',
      args: [],
      cwd: workDir,
      env: {},
    })
    expect(proc.pid).toBeNull()
    const status = await proc.exit()
    expect(status.code).toBeNull()
    expect(status.spawnError?.code).toBe('ENOENT')
    expect(await collect(proc.stdout())).toEqual([])
  }, 20_000)

  it('usa o spawn e o relogio injetados', async () => {
    const child = new FakeChild()
    const instantes = [1000, 1750]
    const proc = spawnStreaming(
      { command: 'irrelevante', args: ['a'], cwd: '/tmp', env: {} },
      {
        spawn: fakeSpawn(child),
        now: () => instantes.shift() ?? 9999,
        newHandle: () => 'handle-fixo',
      },
    )
    expect(proc.handle).toBe('handle-fixo')
    expect(proc.pid).toBe(4242)
    expect(proc.startedAt.getTime()).toBe(1000)

    child.stdout.end('uma\ndois\n')
    child.stderr.end()
    await delay(20)
    child.emit('exit', 0, null)
    child.emit('close', 0, null)

    const status = await proc.exit()
    expect(status.durationMs).toBe(750)
    expect(status.code).toBe(0)
    expect(await collect(proc.stdout())).toEqual(['uma', 'dois'])
  })

  it('sinaliza o grupo do processo com o pid negativo', async () => {
    const child = new FakeChild()
    const sinais: [number, NodeJS.Signals][] = []
    const proc = spawnStreaming(
      { command: 'irrelevante', args: [], cwd: '/tmp', env: {} },
      {
        spawn: fakeSpawn(child),
        platform: 'linux',
        killGraceMs: 30,
        kill: (pid, signal) => {
          sinais.push([pid, signal])
          if (signal === 'SIGKILL') {
            child.stdout.end()
            child.stderr.end()
            setTimeout(() => child.emit('close', null, 'SIGKILL'), 5)
          }
        },
      },
    )
    await proc.cancel('parar')
    const status = await proc.exit()
    expect(sinais).toEqual([
      [-4242, 'SIGTERM'],
      [-4242, 'SIGKILL'],
    ])
    expect(status.cancelled).toBe(true)
    expect(status.signal).toBe('SIGKILL')
  })

  it('trata erro de spawn sem pid como falha estruturada', async () => {
    const child = new FakeChild()
    child.pid = undefined
    const proc = spawnStreaming(
      { command: 'irrelevante', args: [], cwd: '/tmp', env: {} },
      { spawn: fakeSpawn(child) },
    )
    const erro = Object.assign(new Error('spawn falhou'), { code: 'EACCES' })
    child.emit('error', erro)
    const status = await proc.exit()
    expect(status.spawnError).toEqual({ code: 'EACCES', message: 'spawn falhou' })
    expect(status.code).toBeNull()
    expect(status.cancelled).toBe(false)
  })

  it('trata excecao sincrona do spawn como falha estruturada', async () => {
    const proc = spawnStreaming(
      { command: 'irrelevante', args: [], cwd: '/tmp', env: {} },
      {
        spawn: () => {
          throw new Error('sem recursos')
        },
      },
    )
    expect(proc.pid).toBeNull()
    const status = await proc.exit()
    expect(status.spawnError?.code).toBe('SPAWN_FAILED')
    expect(status.spawnError?.message).toBe('sem recursos')
  })
})
