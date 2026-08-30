import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { runCaptured } from './runtime.js'
import type { RunSpec } from './types.js'
import { DEFAULT_MAX_OUTPUT_BYTES } from './types.js'

const NODE = nodeProcess.execPath
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-process-')))

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const run = (code: string, extra: Partial<RunSpec> = {}) =>
  runCaptured({ command: NODE, args: ['-e', code], cwd: workDir, env: {}, ...extra })

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('runCaptured', () => {
  it('reporta saida bem-sucedida', async () => {
    const result = await run('process.stdout.write("pronto")')
    expect(result.code).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.cancelled).toBe(false)
    expect(result.stdout).toBe('pronto')
  })

  it('preserva o codigo de saida diferente de zero', async () => {
    const result = await run('process.exitCode = 3')
    expect(result.code).toBe(3)
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
  })

  it('captura stdout e stderr separadamente', async () => {
    const result = await run('process.stdout.write("saida\\n"); process.stderr.write("erro\\n")')
    expect(result.stdout).toBe('saida\n')
    expect(result.stderr).toBe('erro\n')
  })

  it('executa no cwd informado', async () => {
    const result = await run('process.stdout.write(process.cwd())')
    expect(realpathSync(result.stdout)).toBe(workDir)
  })

  it('entrega stdin ao filho', async () => {
    const result = await run(
      'let d = ""; process.stdin.on("data", (c) => { d += c }); process.stdin.on("end", () => process.stdout.write(d.toUpperCase()))',
      { stdin: 'ola mundo' },
    )
    expect(result.stdout).toBe('OLA MUNDO')
  })

  it('nao trava quando o filho ignora stdin', async () => {
    const result = await run('process.stdout.write("ok")', { stdin: 'ignorado' })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('ok')
  })

  it('digere o conteudo capturado quando nada e truncado', async () => {
    const result = await run('process.stdout.write("conteudo digerido")')
    expect(result.stdoutTruncated).toBe(false)
    expect(result.stdoutDigest).toBe(sha256('conteudo digerido'))
    expect(result.stderrDigest).toBe(sha256(''))
  })

  it('trunca stdout acima do limite mas digere o conteudo completo', async () => {
    const line = `${'x'.repeat(99)}\n`
    const total = 200
    const result = await run(
      `const l = "x".repeat(99) + "\\n"; for (let i = 0; i < ${total}; i += 1) process.stdout.write(l)`,
      { maxOutputBytes: 1000 },
    )
    expect(result.code).toBe(0)
    expect(result.stdoutTruncated).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBe(1000)
    expect(result.stdoutDigest).toBe(sha256(line.repeat(total)))
  })

  it('trunca stderr de forma independente de stdout', async () => {
    const result = await run(
      'process.stdout.write("curto"); process.stderr.write("e".repeat(5000))',
      { maxOutputBytes: 100 },
    )
    expect(result.stdoutTruncated).toBe(false)
    expect(result.stderrTruncated).toBe(true)
    expect(result.stderr).toBe('e'.repeat(100))
    expect(result.stderrDigest).toBe(sha256('e'.repeat(5000)))
  })

  it('continua consumindo o filho depois de truncar (o processo termina sozinho)', async () => {
    const result = await run(
      'for (let i = 0; i < 2000; i += 1) process.stdout.write("linha ".repeat(20) + "\\n"); process.stdout.write("FIM")',
      { maxOutputBytes: 64 },
    )
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdout.length).toBeLessThanOrEqual(64)
  })

  it('sem maxOutputBytes, o limite padrao e 1 MiB por stream', async () => {
    const total = DEFAULT_MAX_OUTPUT_BYTES + 4096
    const result = await run(
      `const b = Buffer.alloc(4096, 0x61); for (let i = 0; i < ${total / 4096}; i += 1) process.stdout.write(b)`,
    )
    expect(result.code).toBe(0)
    expect(result.stdoutTruncated).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBe(DEFAULT_MAX_OUTPUT_BYTES)
    expect(result.stdoutDigest).toBe(sha256('a'.repeat(total)))
  }, 20_000)

  it('devolve resultado estruturado quando o comando nao existe', async () => {
    const result = await runCaptured({
      command: 'agentic-comando-que-nao-existe-xyz',
      args: [],
      cwd: workDir,
      env: {},
    })
    expect(result.code).toBeNull()
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.cancelled).toBe(false)
    expect(result.spawnError?.code).toBe('ENOENT')
    expect(result.stdout).toBe('')
  })

  it('devolve resultado estruturado quando o cwd nao existe', async () => {
    const result = await runCaptured({
      command: NODE,
      args: ['-e', 'process.stdout.write("x")'],
      cwd: join(workDir, 'diretorio-inexistente'),
      env: {},
    })
    expect(result.code).toBeNull()
    expect(result.spawnError?.code).toBe('ENOENT')
  })

  it('mede a duracao', async () => {
    const result = await run('process.stdout.write("x")')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.durationMs).toBeLessThan(30_000)
  })

  it('so entrega ao filho as variaveis da allowlist', async () => {
    nodeProcess.env.AG_PARENT_ONLY = 'nao-deve-vazar'
    try {
      const result = await run('process.stdout.write(JSON.stringify(process.env))', {
        env: { AG_PERMITIDA: 'ok' },
      })
      const childEnv = JSON.parse(result.stdout) as Record<string, string>
      expect(childEnv.AG_PERMITIDA).toBe('ok')
      expect(childEnv.AG_PARENT_ONLY).toBeUndefined()
      expect(childEnv.PATH).toBeUndefined()
    } finally {
      delete nodeProcess.env.AG_PARENT_ONLY
    }
  })

  it('nao vaza o ambiente inteiro do pai nem por acidente', async () => {
    const result = await run('process.stdout.write(String(Object.keys(process.env).length))', {
      env: { UNICA: '1' },
    })
    expect(Number(result.stdout)).toBeLessThanOrEqual(2)
  })
})
