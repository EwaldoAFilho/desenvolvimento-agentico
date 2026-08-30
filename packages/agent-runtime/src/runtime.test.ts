import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import type { LocalAgentProcess, LocalAgentRuntime, SpawnOptions } from '@agentic/domain'
import { afterAll, describe, expect, it } from 'vitest'
import { FAKE_CLI, makeFakeCli, makeTempDir, PROVIDER, spec } from './__fixtures__/fake-cli.js'
import { ProviderUnavailableError, WorkspaceCwdError } from './errors.js'
import { createLocalAgentRuntime } from './runtime.js'

const NODE = nodeProcess.execPath
const cli = makeFakeCli()
const workDir = makeTempDir('agentic-worktree-')
const arquivo = join(workDir, 'arquivo.txt')
writeFileSync(arquivo, 'nao sou diretorio')

const runtime = createLocalAgentRuntime({
  platform: 'linux',
  pathEnv: cli.dir,
  processDeps: { killGraceMs: 200, closeGraceMs: 300 },
})

const nodeSpec = (script: string) => spec({ executable: NODE, args: ['-e', script] })

const opts = (overrides: Partial<SpawnOptions> = {}): SpawnOptions => ({
  cwd: workDir,
  env: {},
  timeoutMs: 15_000,
  ...overrides,
})

const firstLine = async (source: AsyncIterable<string>): Promise<string> => {
  for await (const line of source) return line
  return ''
}

const allLines = async (source: AsyncIterable<string>): Promise<string[]> => {
  const out: string[] = []
  for await (const line of source) out.push(line)
  return out
}

afterAll(() => {
  rmSync(cli.dir, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

describe('spawn — cwd obrigatorio (I11)', () => {
  it('recusa cwd inexistente com WORKSPACE_ERROR estruturado', async () => {
    const erro = await runtime
      .spawn(nodeSpec('0'), opts({ cwd: join(workDir, 'worktree-que-nao-existe') }))
      .catch((e: unknown) => e)
    expect(erro).toBeInstanceOf(WorkspaceCwdError)
    if (!(erro instanceof WorkspaceCwdError)) throw new Error('esperava WorkspaceCwdError')
    expect(erro.failureCode).toBe('WORKSPACE_ERROR')
    expect(erro.providerId).toBe(PROVIDER)
    expect(erro.toFailureReason().code).toBe('WORKSPACE_ERROR')
  })

  it('recusa cwd que aponta para arquivo', async () => {
    const erro = await runtime.spawn(nodeSpec('0'), opts({ cwd: arquivo })).catch((e: unknown) => e)
    expect(erro).toBeInstanceOf(WorkspaceCwdError)
  })

  it('recusa cwd vazio', async () => {
    const erro = await runtime.spawn(nodeSpec('0'), opts({ cwd: '   ' })).catch((e: unknown) => e)
    expect(erro).toBeInstanceOf(WorkspaceCwdError)
  })

  it('recusa cwd relativo: a worktree e sempre caminho absoluto', async () => {
    const erro = await runtime.spawn(nodeSpec('0'), opts({ cwd: './worktree' })).catch((e) => e)
    expect(erro).toBeInstanceOf(WorkspaceCwdError)
    if (!(erro instanceof WorkspaceCwdError)) throw new Error('esperava WorkspaceCwdError')
    expect(erro.detail).toContain('absoluto')
  })

  it('recusa quando a inspecao do cwd falha por motivo inesperado', async () => {
    const quebrado = createLocalAgentRuntime({
      platform: 'linux',
      isDirectory: () => Promise.reject(new Error('io quebrado')),
    })
    const erro = await quebrado.spawn(nodeSpec('0'), opts()).catch((e: unknown) => e)
    expect(erro).toBeInstanceOf(WorkspaceCwdError)
    if (!(erro instanceof WorkspaceCwdError)) throw new Error('esperava WorkspaceCwdError')
    expect(erro.detail).toContain('io quebrado')
  })

  it('inicia o processo dentro do cwd informado', async () => {
    const proc = await runtime.spawn(
      nodeSpec('process.stdout.write(process.cwd() + "\\n")'),
      opts(),
    )
    expect(await firstLine(proc.stdout)).toBe(workDir)
    expect(proc.cwd).toBe(workDir)
    await proc.exit()
  })
})

describe('spawn — ambiente (P17/ADR-0009)', () => {
  it('nao repassa variavel do ambiente do control plane que nao esteja na allowlist', async () => {
    nodeProcess.env.SEGREDO_DO_TESTE = 'vazou'
    try {
      const proc = await runtime.spawn(
        nodeSpec('process.stdout.write(String(process.env.SEGREDO_DO_TESTE) + "\\n")'),
        opts({ env: { OUTRA: 'coisa' } }),
      )
      expect(await firstLine(proc.stdout)).toBe('undefined')
      await proc.exit()
    } finally {
      delete nodeProcess.env.SEGREDO_DO_TESTE
    }
  })

  it('entrega exatamente a allowlist montada pelo chamador, sem acrescimo', async () => {
    const proc = await runtime.spawn(
      nodeSpec('process.stdout.write(Object.keys(process.env).sort().join(",") + "\\n")'),
      opts({ env: { ALPHA: '1', BETA: '2' } }),
    )
    expect(await firstLine(proc.stdout)).toBe('ALPHA,BETA')
    await proc.exit()
  })

  it('nao injeta credencial alguma quando a allowlist e vazia', async () => {
    const proc = await runtime.spawn(
      nodeSpec('process.stdout.write(String(Object.keys(process.env).length) + "\\n")'),
      opts({ env: {} }),
    )
    expect(await firstLine(proc.stdout)).toBe('0')
    await proc.exit()
  })
})

describe('spawn — handle e streams', () => {
  it('expoe handle, pid, cwd e startedAt', async () => {
    const antes = Date.now()
    const proc: LocalAgentProcess = await runtime.spawn(nodeSpec('0'), opts())
    expect(proc.handle).toMatch(/^proc_/)
    expect(typeof proc.pid).toBe('number')
    expect(proc.cwd).toBe(workDir)
    expect(proc.startedAt.getTime()).toBeGreaterThanOrEqual(antes - 1000)
    await proc.exit()
  })

  it('transmite stdout em linhas', async () => {
    const proc = await runtime.spawn(nodeSpec('console.log("uma"); console.log("outra")'), opts())
    expect(await allLines(proc.stdout)).toEqual(['uma', 'outra'])
    await proc.exit()
  })

  it('transmite stderr separado de stdout', async () => {
    const proc = await runtime.spawn(
      nodeSpec('console.log("saida"); console.error("erro")'),
      opts(),
    )
    expect(await allLines(proc.stderr)).toEqual(['erro'])
    expect(await allLines(proc.stdout)).toEqual(['saida'])
    await proc.exit()
  })

  it('entrega stdin ao processo', async () => {
    const proc = await runtime.spawn(
      nodeSpec(
        'let b = ""; process.stdin.on("data", (c) => { b += c }); process.stdin.on("end", () => process.stdout.write(b.toUpperCase() + "\\n"))',
      ),
      opts({ stdin: 'contrato' }),
    )
    expect(await firstLine(proc.stdout)).toBe('CONTRATO')
    await proc.exit()
  })

  it('resolve o executavel pelo PATH da allowlist do chamador', async () => {
    // O PATH do control plane aponta para lugar nenhum: so o PATH do chamador pode achar a CLI.
    const semPath = createLocalAgentRuntime({
      platform: 'linux',
      pathEnv: join(workDir, 'path-que-nao-existe'),
      processDeps: { killGraceMs: 200, closeGraceMs: 300 },
    })
    const proc = await semPath.spawn(
      spec({ executable: FAKE_CLI, args: ['--version'] }),
      opts({ env: { PATH: cli.dir } }),
    )
    expect(await firstLine(proc.stdout)).toContain('1.2.3')
    await proc.exit()
  })

  it('sem PATH do chamador nem do runtime, executavel por nome vira PROVIDER_UNAVAILABLE', async () => {
    const semPath = createLocalAgentRuntime({
      platform: 'linux',
      pathEnv: join(workDir, 'path-que-nao-existe'),
    })
    const erro = await semPath
      .spawn(spec({ executable: FAKE_CLI, args: ['--version'] }), opts({ env: {} }))
      .catch((e: unknown) => e)
    expect(erro).toBeInstanceOf(ProviderUnavailableError)
  })
})

describe('spawn — encerramento', () => {
  it('processo que termina bem devolve code 0 sem timeout nem cancelamento', async () => {
    const proc = await runtime.spawn(nodeSpec('process.exit(0)'), opts())
    const status = await proc.exit()
    expect(status).toMatchObject({ code: 0, timedOut: false, cancelled: false })
    expect(status.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('preserva codigo de saida diferente de zero', async () => {
    const proc = await runtime.spawn(nodeSpec('process.exit(7)'), opts())
    expect((await proc.exit()).code).toBe(7)
  })

  it('cancelamento produz cancelled true e timedOut false', async () => {
    const proc = await runtime.spawn(nodeSpec('setInterval(() => {}, 1000)'), opts())
    await proc.cancel('humano pediu parada')
    const status = await proc.exit()
    expect(status.cancelled).toBe(true)
    expect(status.timedOut).toBe(false)
    expect(status.cancelReason).toBe('humano pediu parada')
  })

  it('timeout produz timedOut true e cancelled false', async () => {
    const proc = await runtime.spawn(
      nodeSpec('setInterval(() => {}, 1000)'),
      opts({ timeoutMs: 250 }),
    )
    const status = await proc.exit()
    expect(status.timedOut).toBe(true)
    expect(status.cancelled).toBe(false)
  })

  it('exit e estavel entre chamadas', async () => {
    const proc = await runtime.spawn(nodeSpec('process.exit(3)'), opts())
    const primeiro = await proc.exit()
    const segundo = await proc.exit()
    expect(segundo).toEqual(primeiro)
  })
})

describe('spawn — executavel ausente', () => {
  it('recusa com PROVIDER_UNAVAILABLE estruturado', async () => {
    const erro = await runtime
      .spawn(spec({ executable: 'cli-inexistente-xyz' }), opts({ env: { PATH: cli.dir } }))
      .catch((e: unknown) => e)
    expect(erro).toBeInstanceOf(ProviderUnavailableError)
    if (!(erro instanceof ProviderUnavailableError)) throw new Error('esperava indisponivel')
    expect(erro.failureCode).toBe('PROVIDER_UNAVAILABLE')
    expect(erro.toFailureReason()).toEqual({
      code: 'PROVIDER_UNAVAILABLE',
      detail: erro.detail,
    })
  })
})

describe('probe pelo runtime', () => {
  it('satisfaz a porta LocalAgentRuntime do dominio', () => {
    const porta: LocalAgentRuntime = createLocalAgentRuntime()
    expect(typeof porta.probe).toBe('function')
    expect(typeof porta.spawn).toBe('function')
  })

  it('delega ao probe com as mesmas dependencias', async () => {
    const health = await runtime.probe(spec({ executable: FAKE_CLI, versionArgs: ['--version'] }))
    expect(health.installed).toBe(true)
    expect(health.version).toBe('1.2.3')
    expect(health.ready).toBe('unknown')
  })
})
