import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAgentRuntimeError, WorkspaceCwdError } from '@agentic/agent-runtime'
import type {
  AgentLogEvent,
  DispatchContext,
  ExecuteAssignment,
  ReviewAssignment,
} from '@agentic/domain'
import {
  attemptId,
  consumesAttempt,
  gateId,
  missionId,
  pathScope,
  runId,
  taskId,
} from '@agentic/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProviderAtCapacityError } from './errors.js'
import type { HealthCheckedAgentProvider } from './provider.js'

/** Arquivo que o agente do cenario `success` escreve na worktree, com o cwd observado. */
export const CONTRACT_CWD_FILE = 'agent-cwd.txt'
export const CONTRACT_STDOUT_MARK = 'agente: relato em stdout'
export const CONTRACT_STDERR_MARK = 'agente: aviso em stderr'

/**
 * Cenarios que todo adapter precisa saber encenar. Sao situacoes de ambiente, nao de
 * implementacao: quem monta o duble e o harness do adapter.
 */
export type ContractScenario = 'success' | 'failure' | 'slow' | 'unavailable' | 'not-ready'

export interface ContractCreateOptions {
  /** Quando presente, o provider e construido com contabilidade de vagas deste tamanho. */
  readonly maxConcurrent?: number
}

export interface ContractSetup {
  readonly provider: HealthCheckedAgentProvider
  /** Worktree da tentativa: caminho absoluto existente. */
  readonly workspace: string
  /** Allowlist extra que o duble precisa (nunca credencial). */
  readonly env?: Readonly<Record<string, string>>
  readonly cleanup?: () => void | Promise<void>
}

export interface ProviderContractHarness {
  create(scenario: ContractScenario, options?: ContractCreateOptions): Promise<ContractSetup>
}

export type ProviderContractFactory = () =>
  | ProviderContractHarness
  | Promise<ProviderContractHarness>

const MISSION = missionId('DA-CORE-001')
const RUN = runId('01J0000000000000000000000A')
const TASK = taskId('T09')
const ATTEMPT = attemptId('T09-a1')

function baseAssignment(workspacePath: string, timeoutMs: number): ExecuteAssignment {
  return {
    kind: 'execute',
    missionId: MISSION,
    runId: RUN,
    taskId: TASK,
    attemptId: ATTEMPT,
    objective: 'Provar que a porta AgentProvider e uma porta de verdade',
    constraints: ['nenhum adapter pode exigir API key'],
    touches: [pathScope('packages/providers/')],
    reads: [pathScope('packages/domain/')],
    denyPaths: ['.agentic/'],
    satisfiedDependencies: [taskId('T17')],
    validation: ['a mesma suite roda igual nos tres adapters'],
    workspacePath,
    timeoutMs,
  }
}

function reviewOf(workspacePath: string, timeoutMs: number): ReviewAssignment {
  return {
    ...baseAssignment(workspacePath, timeoutMs),
    kind: 'review',
    diffRef: 'diff:sha256-contrato',
    gateExecutions: [
      {
        id: 'gate-exec-contrato',
        gateId: gateId('unit'),
        scope: 'task',
        runId: RUN,
        startedAt: new Date('2026-01-01T10:00:00.000Z'),
        status: 'PASS',
        results: [
          {
            command: 'npm test',
            cwd: workspacePath,
            exitCode: 0,
            durationMs: 10,
            truncated: false,
          },
        ],
      },
    ],
    policy: 'cross-provider-required',
  }
}

function contextOf(setup: ContractSetup, timeoutMs: number): DispatchContext {
  return {
    runId: RUN,
    taskId: TASK,
    attemptId: ATTEMPT,
    workspace: {
      id: 'ws-contrato',
      kind: 'git-worktree',
      path: setup.workspace,
      leasedBy: ATTEMPT,
    },
    timeoutMs,
    env: { ...(setup.env ?? {}) },
  }
}

async function collect(source: AsyncIterable<AgentLogEvent>): Promise<AgentLogEvent[]> {
  const out: AgentLogEvent[] = []
  for await (const event of source) out.push(event)
  return out
}

function chunks(events: readonly AgentLogEvent[], stream: AgentLogEvent['stream']): string {
  return events
    .filter((event) => event.stream === stream)
    .map((event) => event.chunk)
    .join('\n')
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  )
}

/**
 * Suite de contrato unica (ADR-0010 1). Os tres adapters rodam exatamente estes casos:
 * disponibilidade, cwd, ciclo de vida, stdout, stderr, status de saida, timeout,
 * cancelamento, CLI ausente, CLI nao pronta e capacidade. Nenhum caso toca a rede nem
 * consome quota — os adapters reais recebem dubles de processo.
 */
export function runProviderContract(name: string, factory: ProviderContractFactory): void {
  describe(`contrato AgentProvider — ${name}`, () => {
    const cleanups: (() => void | Promise<void>)[] = []
    let harness: ProviderContractHarness

    beforeAll(async () => {
      harness = await factory()
    })

    afterAll(async () => {
      for (const cleanup of [...cleanups].reverse()) await cleanup()
      cleanups.length = 0
    })

    const open = async (
      scenario: ContractScenario,
      options?: ContractCreateOptions,
    ): Promise<ContractSetup> => {
      const setup = await harness.create(scenario, options)
      if (setup.cleanup !== undefined) cleanups.push(setup.cleanup)
      return setup
    }

    describe('disponibilidade', () => {
      it('declara capacidades: papeis, streaming, cancelamento e sonda de prontidao', async () => {
        const { provider } = await open('success')
        const capabilities = provider.capabilities()
        expect(provider.id.length).toBeGreaterThan(0)
        expect(capabilities.roles.length).toBeGreaterThan(0)
        expect(capabilities.roles).toContain('executor')
        expect(['supported', 'unsupported']).toContain(capabilities.readinessProbe)
        expect(typeof capabilities.streaming).toBe('boolean')
        expect(typeof capabilities.cancellation).toBe('boolean')
        expect(typeof capabilities.reportsUsage).toBe('boolean')
      })

      it('health() responde com running e capacity sempre conhecidos', async () => {
        const { provider } = await open('success')
        const health = await provider.health()
        expect(health.providerId).toBe(provider.id)
        expect(Number.isInteger(health.running)).toBe(true)
        expect(health.capacity === null || Number.isInteger(health.capacity)).toBe(true)
        expect([true, false, 'unknown']).toContain(health.installed)
        expect([true, false, 'unknown']).toContain(health.ready)
        expect(health.detail.length).toBeGreaterThan(0)
        expect(health.probedAt).toBeInstanceOf(Date)
      })

      it('nao inventa prontidao: sonda ausente reporta unknown, nunca true', async () => {
        const { provider } = await open('success')
        const health = await provider.health()
        if (provider.capabilities().readinessProbe === 'unsupported') {
          expect(health.ready).toBe('unknown')
          expect(health.ready).not.toBe(true)
          return
        }
        expect(health.ready).toBe(true)
      })
    })

    describe('cwd (I11)', () => {
      it('executa dentro da worktree informada e escreve la', async () => {
        const setup = await open('success')
        const handle = await setup.provider.start(
          baseAssignment(setup.workspace, 15_000),
          contextOf(setup, 15_000),
        )
        const outcome = await handle.result()
        expect(outcome.status).toBe('completed')
        const observed = await readFile(join(setup.workspace, CONTRACT_CWD_FILE), 'utf8')
        expect(observed.trim()).toBe(setup.workspace)
      })

      it('recusa cwd que nao e um diretorio existente', async () => {
        const setup = await open('success')
        const inexistente = join(setup.workspace, 'worktree-que-nao-existe')
        const quebrado: ContractSetup = { ...setup, workspace: inexistente }
        const error = await failureOf(
          setup.provider.start(baseAssignment(inexistente, 15_000), contextOf(quebrado, 15_000)),
        )
        expect(error).toBeInstanceOf(WorkspaceCwdError)
      })
    })

    describe('ciclo de vida do processo', () => {
      it('ref e estavel e o status acompanha o processo ate o estado terminal', async () => {
        const setup = await open('slow')
        const handle = await setup.provider.start(
          baseAssignment(setup.workspace, 15_000),
          contextOf(setup, 15_000),
        )
        const primeiraLeitura = handle.ref
        expect(primeiraLeitura.length).toBeGreaterThan(0)
        expect(handle.ref).toBe(primeiraLeitura)
        expect(handle.status()).toBe('running')
        await handle.cancel('fim do caso de ciclo de vida')
        const outcome = await handle.result()
        expect(outcome.status).toBe('cancelled')
        expect(handle.status()).toBe('cancelled')
      })

      it('logs() pode ser consumido depois do termino e replica tudo', async () => {
        const setup = await open('success')
        const handle = await setup.provider.start(
          baseAssignment(setup.workspace, 15_000),
          contextOf(setup, 15_000),
        )
        await handle.result()
        const first = await collect(handle.logs())
        const second = await collect(handle.logs())
        expect(first.length).toBeGreaterThan(0)
        expect(second.map((e) => e.chunk)).toEqual(first.map((e) => e.chunk))
      })
    })

    describe('streams', () => {
      it('entrega stdout do agente como evento de log', async () => {
        const setup = await open('success')
        if (!setup.provider.capabilities().streaming) return
        const handle = await setup.provider.start(
          baseAssignment(setup.workspace, 15_000),
          contextOf(setup, 15_000),
        )
        await handle.result()
        expect(chunks(await collect(handle.logs()), 'stdout')).toContain(CONTRACT_STDOUT_MARK)
      })

      it('entrega log enquanto o processo ainda roda, nao so no fim', async () => {
        const setup = await open('slow')
        if (!setup.provider.capabilities().streaming) return
        const handle = await setup.provider.start(
          baseAssignment(setup.workspace, 15_000),
          contextOf(setup, 15_000),
        )
        // Streaming e entrega incremental: se o adapter so publicasse no fim, este laco
        // ficaria preso ate o agente lento terminar e o caso estouraria o tempo.
        let visto: AgentLogEvent | undefined
        for await (const event of handle.logs()) {
          if (event.stream === 'stdout' && event.chunk.includes(CONTRACT_STDOUT_MARK)) {
            visto = event
            break
          }
        }
        expect(visto).toBeDefined()
        expect(handle.status()).toBe('running')
        await handle.cancel('fim do caso de streaming')
        await handle.result()
      })

      it('entrega stderr do agente como evento de log', async () => {
        const setup = await open('success')
        if (!setup.provider.capabilities().streaming) return
        const handle = await setup.provider.start(
          baseAssignment(setup.workspace, 15_000),
          contextOf(setup, 15_000),
        )
        await handle.result()
        expect(chunks(await collect(handle.logs()), 'stderr')).toContain(CONTRACT_STDERR_MARK)
      })
    })

    describe('status de saida', () => {
      it('saida zero vira completed, com claims e logsRef preenchidos', async () => {
        const setup = await open('success')
        const handle = await setup.provider.start(
          baseAssignment(setup.workspace, 15_000),
          contextOf(setup, 15_000),
        )
        const outcome = await handle.result()
        expect(outcome.status).toBe('completed')
        expect(outcome.claims.summary.length).toBeGreaterThan(0)
        expect(outcome.logsRef.length).toBeGreaterThan(0)
        expect(handle.status()).toBe('completed')
      })

      it('saida diferente de zero vira failed sem virar timeout nem cancelamento', async () => {
        const setup = await open('failure')
        const handle = await setup.provider.start(
          baseAssignment(setup.workspace, 15_000),
          contextOf(setup, 15_000),
        )
        const outcome = await handle.result()
        expect(outcome.status).toBe('failed')
        expect(outcome.claims.summary.length).toBeGreaterThan(0)
        expect(handle.status()).toBe('failed')
      })

      it('aceita assignment de revisao quando declara o papel de revisor', async () => {
        const setup = await open('success')
        if (!setup.provider.capabilities().roles.includes('reviewer')) return
        const handle = await setup.provider.start(
          reviewOf(setup.workspace, 15_000),
          contextOf(setup, 15_000),
        )
        const outcome = await handle.result()
        expect(outcome.status).toBe('completed')
      })
    })

    describe('timeout e cancelamento', () => {
      it('estouro de tempo vira timeout, distinto de erro do agente', async () => {
        const setup = await open('slow')
        const handle = await setup.provider.start(
          baseAssignment(setup.workspace, 400),
          contextOf(setup, 400),
        )
        const outcome = await handle.result()
        expect(outcome.status).toBe('timeout')
        expect(handle.status()).toBe('failed')
      })

      it('cancelamento vira cancelled, distinto de erro do agente', async () => {
        const setup = await open('slow')
        if (!setup.provider.capabilities().cancellation) return
        const handle = await setup.provider.start(
          baseAssignment(setup.workspace, 15_000),
          contextOf(setup, 15_000),
        )
        await handle.cancel('operador pediu parada')
        const outcome = await handle.result()
        expect(outcome.status).toBe('cancelled')
      })
    })

    describe('falhas de ambiente do fornecedor', () => {
      it('agente ausente vira PROVIDER_UNAVAILABLE e nao consome tentativa util', async () => {
        const setup = await open('unavailable')
        const error = await failureOf(
          setup.provider.start(baseAssignment(setup.workspace, 15_000), contextOf(setup, 15_000)),
        )
        expect(isAgentRuntimeError(error)).toBe(true)
        if (!isAgentRuntimeError(error)) return
        expect(error.failureCode).toBe('PROVIDER_UNAVAILABLE')
        expect(consumesAttempt(error.failureCode)).toBe(false)
      })

      it('sonda de prontidao reprovando vira PROVIDER_NOT_READY', async () => {
        const setup = await open('not-ready')
        if (setup.provider.capabilities().readinessProbe !== 'supported') {
          // Sem sonda nao ha reprovacao possivel: a honestidade e o proprio contrato.
          expect((await setup.provider.health()).ready).toBe('unknown')
          return
        }
        const error = await failureOf(
          setup.provider.start(baseAssignment(setup.workspace, 15_000), contextOf(setup, 15_000)),
        )
        expect(isAgentRuntimeError(error)).toBe(true)
        if (!isAgentRuntimeError(error)) return
        expect(error.failureCode).toBe('PROVIDER_NOT_READY')
        expect(consumesAttempt(error.failureCode)).toBe(false)
      })

      it('sem sonda suportada, prontidao fica unknown e o despacho segue', async () => {
        const setup = await open('not-ready')
        if (setup.provider.capabilities().readinessProbe === 'supported') {
          expect((await setup.provider.health()).ready).toBe(false)
          return
        }
        const health = await setup.provider.health()
        expect(health.ready).toBe('unknown')
        expect(health.installed).toBe(true)
        const handle = await setup.provider.start(
          baseAssignment(setup.workspace, 15_000),
          contextOf(setup, 15_000),
        )
        expect((await handle.result()).status).toBe('completed')
      })
    })

    describe('capacidade (I9)', () => {
      it('recusa despacho alem do maxConcurrent declarado', async () => {
        const setup = await open('slow', { maxConcurrent: 1 })
        const first = await setup.provider.start(
          baseAssignment(setup.workspace, 15_000),
          contextOf(setup, 15_000),
        )
        const error = await failureOf(
          setup.provider.start(baseAssignment(setup.workspace, 15_000), contextOf(setup, 15_000)),
        )
        expect(error).toBeInstanceOf(ProviderAtCapacityError)
        await first.cancel('fim do caso de capacidade')
        await first.result()
      })

      it('libera a vaga ao fim da execucao', async () => {
        const setup = await open('slow', { maxConcurrent: 1 })
        const first = await setup.provider.start(
          baseAssignment(setup.workspace, 15_000),
          contextOf(setup, 15_000),
        )
        await first.cancel('libera a vaga')
        await first.result()
        const second = await setup.provider.start(
          baseAssignment(setup.workspace, 15_000),
          contextOf(setup, 15_000),
        )
        expect(second.ref.length).toBeGreaterThan(0)
        await second.cancel('fim do caso de liberacao')
        await second.result()
      })
    })
  })
}
