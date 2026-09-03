import type { Attempt } from '@agentic/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeCli, type FakeCli } from './__fixtures__/fake-cli.js'
import { GATE_ALWAYS_PASS } from './__fixtures__/files.js'
import { createHarness, type Harness } from './__fixtures__/harness.js'
import { AGENT_CAUSE_MAX_CHARS } from './observe.js'

/**
 * P4 do plano da 0.3.0: quando a CLI do fornecedor falha DE VERDADE — versao velha, sessao
 * expirada, modelo invalido — o usuario lia `AGENT_ERROR: agente encerrou com status
 * failed`. A causa existia no arquivo de log da tentativa; a tela nao a mostrava.
 *
 * Aqui a CLI e um executavel de verdade (processo, stderr, exit code); nenhuma CLI de
 * agente e invocada e nenhuma quota e consumida.
 */
let harness: Harness | undefined
let cli: FakeCli | undefined

afterEach(async () => {
  await harness?.cleanup()
  await cli?.cleanup()
  harness = undefined
  cli = undefined
})

const lastAttempt = (attempts: readonly Attempt[]): Attempt => {
  const found = attempts[attempts.length - 1]
  if (found === undefined) throw new Error('nenhuma tentativa registrada')
  return found
}

async function runFailingCli(message: string): Promise<Attempt> {
  cli = await createFakeCli({ default: { kind: 'exit', exitCode: 1, message } })
  harness = await createHarness({
    mission: { requireReview: false, defaultGate: 'unit', maxAttempts: 1, tasks: [{ id: 'T01' }] },
    project: {
      providers: [{ id: 'local', maxConcurrent: 1 }],
      maxParallelTasks: 1,
      maxExecutors: 1,
    },
    gates: { unit: [GATE_ALWAYS_PASS] },
    factory: cli.factory,
  })
  await harness.orchestrator.drain()
  return lastAttempt(await harness.attempts('T01'))
}

describe('AGENT_ERROR carrega a causa observada', () => {
  it('CLI que sai 1 imprimindo a causa: o codigo e AGENT_ERROR e o detalhe traz a linha', async () => {
    const attempt = await runFailingCli('SIMULANDO FALHA XYZ')

    // A classificacao continua saindo do EXIT, nunca do relato (P05/ADR-0006).
    expect(attempt.failureReason?.code).toBe('AGENT_ERROR')
    expect(attempt.failureReason?.detail).toContain('agente encerrou com status failed')
    expect(attempt.failureReason?.detail).toContain('SIMULANDO FALHA XYZ')
  })

  it('o relato continua guardado como relato, sem virar decisao', async () => {
    const attempt = await runFailingCli('SIMULANDO FALHA XYZ')

    expect(attempt.claims?.summary).toContain('SIMULANDO FALHA XYZ')
    expect(attempt.result).not.toBe('PASS')
  })

  it('segredo na saida da CLI e redigido antes de virar detalhe da falha', async () => {
    const attempt = await runFailingCli('login falhou com API_KEY=sk-abcdefgh12345678secreto')

    expect(attempt.failureReason?.detail).toContain('login falhou')
    expect(attempt.failureReason?.detail).not.toContain('sk-abcdefgh12345678secreto')
    expect(attempt.failureReason?.detail).toContain('[REDACTED]')
  })

  it('saida enorme nao vira despejo: a causa e limitada', async () => {
    const attempt = await runFailingCli(`inicio ${'x'.repeat(5_000)} fim`)
    const detail = attempt.failureReason?.detail ?? ''

    expect(detail).toContain('inicio')
    expect(detail.length).toBeLessThan(AGENT_CAUSE_MAX_CHARS + 120)
  })

  it('CLI silenciosa nao inventa causa: a mensagem estavel continua sozinha', async () => {
    cli = await createFakeCli({ default: { kind: 'exit', exitCode: 7, silent: true } })
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      project: {
        providers: [{ id: 'local', maxConcurrent: 1 }],
        maxParallelTasks: 1,
        maxExecutors: 1,
      },
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
    })
    await harness.orchestrator.drain()
    const attempt = lastAttempt(await harness.attempts('T01'))

    expect(attempt.failureReason?.code).toBe('AGENT_ERROR')
    // O fallback do relato ja diz o exit; nada e adivinhado alem do que foi observado.
    expect(attempt.failureReason?.detail).toContain('exit 7')
  })
})
