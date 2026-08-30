import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { StreamSink } from './output.js'
import { runCaptured, spawnStreaming } from './runtime.js'
import { DEFAULT_MAX_LINE_CHARS } from './types.js'

const NODE = nodeProcess.execPath
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-hostile-')))

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const collect = async (source: AsyncIterable<string>): Promise<string[]> => {
  const out: string[] = []
  for await (const line of source) out.push(line)
  return out
}

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('saida sem quebra de linha', () => {
  it('entrega o fragmento em pedacos em vez de acumular sem limite (regressao)', async () => {
    const sink = new StreamSink(1024 * 1024, 16)
    const pending = collect(sink.lines())
    const blob = 'x'.repeat(1600)
    for (let i = 0; i < blob.length; i += 100) sink.push(Buffer.from(blob.slice(i, i + 100)))
    sink.end()

    const lines = await pending
    // Sem o corte, tudo isso ficaria pendente num unico fragmento ate o fim do processo.
    expect(lines).toHaveLength(100)
    expect(Math.max(...lines.map((line) => line.length))).toBe(16)
    expect(lines.join('')).toBe(blob)
  })

  it('o pedaco cortado nunca passa do teto, mesmo com chunk maior que ele', async () => {
    const sink = new StreamSink(1024 * 1024, 8)
    const pending = collect(sink.lines())
    sink.push(Buffer.from('y'.repeat(50)))
    sink.end()

    const lines = await pending
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(8)
    expect(lines.join('')).toBe('y'.repeat(50))
  })

  it('o teto padrao e o do pacote e o conteudo permanece integro', async () => {
    const sink = new StreamSink(4 * DEFAULT_MAX_LINE_CHARS)
    const pending = collect(sink.lines())
    const blob = 'z'.repeat(DEFAULT_MAX_LINE_CHARS * 2 + 7)
    sink.push(Buffer.from(blob))
    sink.end()

    const lines = await pending
    expect(lines).toHaveLength(3)
    expect(lines[0]).toHaveLength(DEFAULT_MAX_LINE_CHARS)
    expect(lines[2]).toHaveLength(7)
    expect(lines.join('')).toBe(blob)
  })

  it('digest cobre o conteudo completo mesmo com a linha gigante truncada', () => {
    const sink = new StreamSink(64, 16)
    sink.push(Buffer.from('w'.repeat(4096)))
    sink.end()
    expect(sink.text()).toBe('w'.repeat(64))
    expect(sink.truncated).toBe(true)
    expect(sink.digest()).toBe(sha256('w'.repeat(4096)))
  })

  it('quebra de linha continua tendo precedencia sobre o corte por tamanho', async () => {
    const sink = new StreamSink(1024, 8)
    const pending = collect(sink.lines())
    sink.push(Buffer.from('curta\nfragmento-bem-longo-sem-quebra'))
    sink.end()

    const lines = await pending
    expect(lines[0]).toBe('curta')
    expect(lines.slice(1).join('')).toBe('fragmento-bem-longo-sem-quebra')
  })
})

describe('processo com saida volumosa', () => {
  it('stdout gigante em uma unica linha nao trava o run e o digest cobre tudo', async () => {
    const bytes = 4 * 1024 * 1024
    const result = await runCaptured(
      {
        command: NODE,
        args: [
          '-e',
          `const b = Buffer.alloc(65536, 0x61); for (let i = 0; i < ${bytes / 65536}; i += 1) process.stdout.write(b)`,
        ],
        cwd: workDir,
        env: {},
        maxOutputBytes: 4096,
      },
      { closeGraceMs: 1000 },
    )
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdoutTruncated).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBe(4096)
    expect(result.stdoutDigest).toBe(sha256('a'.repeat(bytes)))
  }, 30_000)

  it('stderr volumoso nao atrapalha stdout nem o codigo de saida', async () => {
    const result = await runCaptured({
      command: NODE,
      args: [
        '-e',
        'const b = Buffer.alloc(65536, 0x65); for (let i = 0; i < 48; i += 1) process.stderr.write(b + "\\n"); process.stdout.write("RELATO FINAL\\n"); process.exitCode = 0',
      ],
      cwd: workDir,
      env: {},
      maxOutputBytes: 2048,
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('RELATO FINAL\n')
    expect(result.stdoutTruncated).toBe(false)
    expect(result.stderrTruncated).toBe(true)
    expect(Buffer.byteLength(result.stderr)).toBe(2048)
  }, 30_000)

  it('exit code diferente de zero sobrevive a saida volumosa', async () => {
    const result = await runCaptured({
      command: NODE,
      args: [
        '-e',
        'const b = Buffer.alloc(65536, 0x66); for (let i = 0; i < 32; i += 1) process.stdout.write(b); process.exit(9)',
      ],
      cwd: workDir,
      env: {},
      maxOutputBytes: 1024,
    })
    expect(result.code).toBe(9)
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.cancelled).toBe(false)
    expect(result.stdoutTruncated).toBe(true)
  }, 30_000)

  it('modo streaming termina mesmo sem ninguem consumindo os streams', async () => {
    const proc = spawnStreaming({
      command: NODE,
      args: [
        '-e',
        'const b = Buffer.alloc(65536, 0x67); for (let i = 0; i < 64; i += 1) { process.stdout.write(b + "\\n"); process.stderr.write(b + "\\n") } process.stdout.write("FIM\\n")',
      ],
      cwd: workDir,
      env: {},
      maxOutputBytes: 8192,
    })
    const status = await proc.exit()
    expect(status.code).toBe(0)
    expect(status.timedOut).toBe(false)
    expect(status.cancelled).toBe(false)
  }, 30_000)

  it('assinante tardio de saida volumosa recebe replay limitado, nao a saida inteira', async () => {
    const limit = 4096
    const proc = spawnStreaming({
      command: NODE,
      args: [
        '-e',
        'for (let i = 0; i < 4000; i += 1) process.stdout.write("linha ".repeat(8) + i + "\\n")',
      ],
      cwd: workDir,
      env: {},
      maxOutputBytes: limit,
    })
    await proc.exit()
    const replayed = await collect(proc.stdout())
    const chars = replayed.reduce((sum, line) => sum + line.length + 1, 0)
    expect(replayed.length).toBeGreaterThan(0)
    // O replay para de crescer no orcamento do stream: memoria limitada por construcao.
    expect(chars).toBeLessThanOrEqual(limit * 2)
  }, 30_000)
})
