import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isAgentRuntimeError, WorkspaceCwdError } from '@agentic/agent-runtime'
import type { AgentLogEvent, AgentOutcome } from '@agentic/domain'
import { providerId, taskId } from '@agentic/domain'
import { afterAll, describe, expect, it } from 'vitest'
import { dispatchContext, executeAssignment, reviewAssignment } from './__fixtures__/assignments.js'
import { makeTempDir } from './__fixtures__/fake-cli.js'
import { CapacityBook } from './capacity.js'
import { ProviderAtCapacityError } from './errors.js'
import type { MockScript } from './mock.js'
import { MOCK_CWD_TOKEN, MOCK_FALLBACK_STEP, MockAgentProvider, planWrites } from './mock.js'

const workspaces: string[] = []

function worktree(): string {
  const path = makeTempDir('agentic-mock-ws-')
  workspaces.push(path)
  return path
}

afterAll(async () => {
  for (const path of workspaces) await rm(path, { recursive: true, force: true })
})

async function collect(source: AsyncIterable<AgentLogEvent>): Promise<AgentLogEvent[]> {
  const out: AgentLogEvent[] = []
  for await (const event of source) out.push(event)
  return out
}

const ROTEIRO: MockScript = {
  T09: {
    status: 'completed',
    claims: { summary: 'mock: T09 concluida', reportedFiles: ['packages/providers/src/index.ts'] },
    writeFiles: { 'saida.txt': `worktree em ${MOCK_CWD_TOKEN}` },
    stdout: ['linha 1', 'linha 2'],
    stderr: ['aviso'],
  },
  default: { status: 'failed', claims: { summary: 'mock: task fora do roteiro' } },
}

async function run(
  provider: MockAgentProvider,
  path: string,
  taskOverride?: string,
): Promise<AgentOutcome> {
  const assignment =
    taskOverride === undefined
      ? executeAssignment(path)
      : executeAssignment(path, { taskId: taskId(taskOverride) })
  const handle = await provider.start(assignment, dispatchContext(path))
  return handle.result()
}

describe('MockAgentProvider — determinismo', () => {
  it('mesmo roteiro e mesmo workspace produzem exatamente o mesmo outcome, N vezes', async () => {
    const path = worktree()
    const outcomes: string[] = []
    for (let i = 0; i < 6; i += 1) {
      const provider = new MockAgentProvider({ script: ROTEIRO })
      outcomes.push(JSON.stringify(await run(provider, path)))
    }
    expect(new Set(outcomes).size).toBe(1)
  })

  it('o mesmo provider reexecutado produz o mesmo outcome', async () => {
    const path = worktree()
    const provider = new MockAgentProvider({ script: ROTEIRO })
    const primeiro = await run(provider, path)
    const segundo = await run(provider, path)
    expect(segundo).toEqual(primeiro)
  })

  it('logsRef deriva do assignment, entao e reproduzivel', async () => {
    const path = worktree()
    const provider = new MockAgentProvider({ script: ROTEIRO })
    const outcome = await run(provider, path)
    expect(outcome.logsRef).toBe('agent-log:mock/01J0000000000000000000000A/T09/T09-a1')
  })
})

describe('MockAgentProvider — roteiro', () => {
  it('usa a entrada da task quando existe', async () => {
    const provider = new MockAgentProvider({ script: ROTEIRO })
    const outcome = await run(provider, worktree())
    expect(outcome.status).toBe('completed')
    expect(outcome.claims.summary).toBe('mock: T09 concluida')
  })

  it('cai em `default` quando a task nao esta no roteiro', async () => {
    const provider = new MockAgentProvider({ script: ROTEIRO })
    const outcome = await run(provider, worktree(), 'T42')
    expect(outcome.status).toBe('failed')
    expect(outcome.claims.summary).toBe('mock: task fora do roteiro')
  })

  it('cai no passo de fallback quando o roteiro esta vazio', () => {
    const provider = new MockAgentProvider()
    expect(provider.step('T99')).toEqual(MOCK_FALLBACK_STEP)
  })

  it('preserva `claims` como relato, sem deixa-lo decidir o status', async () => {
    const provider = new MockAgentProvider({
      script: { default: { status: 'failed', claims: { summary: 'terminei tudo com sucesso' } } },
    })
    const outcome = await run(provider, worktree())
    expect(outcome.claims.summary).toBe('terminei tudo com sucesso')
    expect(outcome.status).toBe('failed')
  })

  it('repassa `usage` quando o roteiro declara e reflete isso em capabilities', async () => {
    const provider = new MockAgentProvider({
      script: {
        default: {
          status: 'completed',
          claims: { summary: 'com uso' },
          usage: { model: 'mock-1', inputTokens: 10, outputTokens: 5 },
        },
      },
    })
    expect(provider.capabilities().reportsUsage).toBe(true)
    const outcome = await run(provider, worktree())
    expect(outcome.usage).toEqual({ model: 'mock-1', inputTokens: 10, outputTokens: 5 })
  })

  it('sem `usage` no roteiro, capabilities nao promete relatar uso', () => {
    expect(new MockAgentProvider({ script: ROTEIRO }).capabilities().reportsUsage).toBe(false)
  })
})

describe('MockAgentProvider — escrita na worktree', () => {
  it('escreve os arquivos do roteiro dentro do cwd, com {{cwd}} substituido', async () => {
    const path = worktree()
    const provider = new MockAgentProvider({ script: ROTEIRO })
    await run(provider, path)
    expect(await readFile(join(path, 'saida.txt'), 'utf8')).toBe(`worktree em ${path}`)
  })

  it('cria subdiretorios do caminho declarado', async () => {
    const path = worktree()
    const provider = new MockAgentProvider({
      script: {
        default: {
          status: 'completed',
          claims: { summary: 'com subdiretorio' },
          writeFiles: { 'src/nested/arquivo.ts': 'export const x = 1\n' },
        },
      },
    })
    await run(provider, path)
    expect(await readFile(join(path, 'src/nested/arquivo.ts'), 'utf8')).toBe('export const x = 1\n')
  })

  it('escreve tambem quando o roteiro termina em failed: o diff continua observavel', async () => {
    const path = worktree()
    const provider = new MockAgentProvider({
      script: {
        default: {
          status: 'failed',
          claims: { summary: 'falhou depois de mexer' },
          writeFiles: { 'meio-caminho.txt': 'parcial' },
        },
      },
    })
    expect((await run(provider, path)).status).toBe('failed')
    expect(await readFile(join(path, 'meio-caminho.txt'), 'utf8')).toBe('parcial')
  })

  it('recusa roteiro com caminho absoluto', () => {
    expect(() =>
      planWrites(
        { status: 'completed', claims: { summary: 'x' }, writeFiles: { '/etc/passwd': 'nao' } },
        '/tmp/ws',
      ),
    ).toThrow(/absoluto/)
  })

  it('recusa roteiro que escreve fora da worktree', () => {
    expect(() =>
      planWrites(
        { status: 'completed', claims: { summary: 'x' }, writeFiles: { '../fora.txt': 'nao' } },
        '/tmp/ws',
      ),
    ).toThrow(/sai da worktree/)
  })
})

describe('MockAgentProvider — timeout, cancelamento e falhas de ambiente', () => {
  it('delay maior que o limite da tentativa vira timeout de verdade', async () => {
    const path = worktree()
    const provider = new MockAgentProvider({
      script: { default: { status: 'completed', claims: { summary: 'lento' }, delayMs: 5_000 } },
    })
    const handle = await provider.start(
      executeAssignment(path),
      dispatchContext(path, { timeoutMs: 120 }),
    )
    const outcome = await handle.result()
    expect(outcome.status).toBe('timeout')
    expect(handle.status()).toBe('failed')
  })

  it('cancelamento interrompe a espera e reporta o motivo em claims', async () => {
    const path = worktree()
    const provider = new MockAgentProvider({
      script: { default: { status: 'completed', claims: { summary: 'lento' }, delayMs: 30_000 } },
    })
    const handle = await provider.start(executeAssignment(path), dispatchContext(path))
    await handle.cancel('operador parou o run')
    const outcome = await handle.result()
    expect(outcome.status).toBe('cancelled')
    expect(outcome.claims.summary).toContain('operador parou o run')
    expect(handle.status()).toBe('cancelled')
  })

  it('failWith PROVIDER_UNAVAILABLE recusa no start', async () => {
    const path = worktree()
    const provider = new MockAgentProvider({
      script: {
        default: {
          status: 'failed',
          claims: { summary: 'nunca roda' },
          failWith: 'PROVIDER_UNAVAILABLE',
        },
      },
    })
    const error = await provider.start(executeAssignment(path), dispatchContext(path)).then(
      () => null,
      (e: unknown) => e,
    )
    expect(isAgentRuntimeError(error) && error.failureCode).toBe('PROVIDER_UNAVAILABLE')
  })

  it('failWith PROVIDER_NOT_READY recusa no start', async () => {
    const path = worktree()
    const provider = new MockAgentProvider({
      script: {
        default: {
          status: 'failed',
          claims: { summary: 'nunca roda' },
          failWith: 'PROVIDER_NOT_READY',
        },
      },
    })
    const error = await provider.start(executeAssignment(path), dispatchContext(path)).then(
      () => null,
      (e: unknown) => e,
    )
    expect(isAgentRuntimeError(error) && error.failureCode).toBe('PROVIDER_NOT_READY')
  })

  it('recusa cwd relativo com WORKSPACE_ERROR (I11)', async () => {
    const provider = new MockAgentProvider()
    const error = await provider
      .start(executeAssignment('relativo/ws'), dispatchContext('relativo/ws'))
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(error).toBeInstanceOf(WorkspaceCwdError)
  })
})

describe('MockAgentProvider — saude, logs e capacidade', () => {
  it('health reporta in-process instalado e pronto', async () => {
    const health = await new MockAgentProvider().health()
    expect(health.installed).toBe(true)
    expect(health.ready).toBe(true)
    expect(health.version).not.toBe('unknown')
    expect(health.running).toBe(0)
  })

  it('health reflete o roteiro de indisponibilidade', async () => {
    const health = await new MockAgentProvider({ installed: false }).health()
    expect(health.installed).toBe(false)
    expect(health.ready).toBe(false)
    expect(health.version).toBe('unknown')
  })

  it('logs entregam stdout e stderr do roteiro, com replay', async () => {
    const path = worktree()
    const provider = new MockAgentProvider({ script: ROTEIRO })
    const handle = await provider.start(executeAssignment(path), dispatchContext(path))
    await handle.result()
    const eventos = await collect(handle.logs())
    expect(eventos.filter((e) => e.stream === 'stdout').map((e) => e.chunk)).toEqual([
      'linha 1',
      'linha 2',
    ])
    expect(eventos.filter((e) => e.stream === 'stderr').map((e) => e.chunk)).toEqual(['aviso'])
    expect((await collect(handle.logs())).length).toBe(eventos.length)
  })

  it('conta a vaga por papel: revisao e execucao disputam a mesma capacidade', async () => {
    const path = worktree()
    const book = new CapacityBook({ mock: 1 })
    const provider = new MockAgentProvider({
      script: { default: { status: 'completed', claims: { summary: 'lento' }, delayMs: 30_000 } },
      capacity: book,
    })
    const executando = await provider.start(executeAssignment(path), dispatchContext(path))
    expect(book.snapshot().executor.active).toBe(1)
    const erro = await provider.start(reviewAssignment(path), dispatchContext(path)).then(
      () => null,
      (e: unknown) => e,
    )
    expect(erro).toBeInstanceOf(ProviderAtCapacityError)
    await executando.cancel('fim')
    await executando.result()
    expect(book.snapshot().byProvider.mock?.running).toBe(0)
    expect(book.snapshot().executor.active).toBe(0)
  })

  it('provider fora do livro-caixa e recusado como UNKNOWN_PROVIDER', async () => {
    const path = worktree()
    const provider = new MockAgentProvider({
      id: providerId('nao-declarado'),
      capacity: new CapacityBook({ mock: 1 }),
    })
    const erro = await provider.start(executeAssignment(path), dispatchContext(path)).then(
      () => null,
      (e: unknown) => e,
    )
    expect(erro).toBeInstanceOf(ProviderAtCapacityError)
    if (!(erro instanceof ProviderAtCapacityError)) return
    expect(erro.reason).toBe('UNKNOWN_PROVIDER')
  })
})
