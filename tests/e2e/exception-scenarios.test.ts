import { afterEach, describe, expect, it } from 'vitest'
import type { StepFn } from './support/agents.js'
import { missionStep, pass, review } from './support/agents.js'
import { entregaQuebrada } from './support/entregas.js'
import { createMissionHarness, type MissionHarness } from './support/harness.js'
import { taskIdOf } from './support/outcome.js'

/**
 * Os caminhos que provam que o produto nao acredita em ninguem: gate reprovado, relato sem
 * lastro e escrita fora do escopo. Todos sobre a MESMA missao de exemplo.
 */

let harness: MissionHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

describe('retry apos gate reprovado', () => {
  it('conclui na segunda tentativa e preserva as duas no historico', async () => {
    // O agente entrega codigo que nao compila na 1a tentativa. Quem reprova e o gate:
    // `node tests/run.js` falha ao importar o modulo quebrado.
    const step: StepFn = (context) => {
      if (context.kind === 'review') return review('PASS')
      if (context.taskId === 'T01' && context.attemptNumber === 1) {
        return pass('T01: primeira versao entregue', entregaQuebrada('T01'))
      }
      return missionStep(context)
    }
    harness = await createMissionHarness({ step, safetyIntervalMs: 0 })
    await harness.start()
    await harness.drain()

    const task = await harness.task('T01')
    expect(task.status).toBe('DONE')
    expect(task.attemptCount).toBe(2)

    const attempts = await harness.attempts('T01')
    expect(attempts).toHaveLength(2)

    const primeira = attempts[0]
    expect(primeira?.attemptNumber).toBe(1)
    expect(primeira?.result).toBe('FAIL')
    expect(primeira?.failureReason?.code).toBe('GATE_FAILED')
    expect(primeira?.gateExecutions[0]?.status).toBe('FAIL')
    expect(primeira?.gateExecutions[0]?.results[0]?.command).toBe('node tests/run.js')
    expect(primeira?.gateExecutions[0]?.results[0]?.exitCode).toBe(1)
    expect(primeira?.finishedAt).toBeInstanceOf(Date)

    const segunda = attempts[1]
    expect(segunda?.attemptNumber).toBe(2)
    expect(segunda?.result).toBe('PASS')
    expect(segunda?.gateExecutions[0]?.status).toBe('PASS')
    expect(segunda?.id).not.toBe(primeira?.id)

    const tipos = await harness.eventTypes()
    expect(tipos).toContain('task.retry_scheduled')

    // A tentativa reprovada continua no historico: a missao termina e nada e apagado.
    const run = await harness.run()
    expect(run.status).toBe('COMPLETED')
    const report = await harness.plane.generateMissionReport(harness.runId)
    expect(report.retries).toBe(1)
    expect(report.retriedTasks).toEqual([{ taskId: 'T01', attempts: 2, failures: ['GATE_FAILED'] }])
  }, 120_000)
})

describe('claims nao decidem', () => {
  it('nao conclui a task quando o agente diz ter feito tudo e nao escreve arquivo', async () => {
    const step: StepFn = (context) => {
      if (context.kind === 'review') return review('PASS')
      if (context.taskId === 'T02') {
        return {
          status: 'completed',
          claims: {
            summary: 'catalogo indexado por sku, 12 testes passando',
            detail: 'revisei eu mesmo e esta perfeito',
            reportedFiles: ['src/catalogo.js'],
          },
        }
      }
      return missionStep(context)
    }
    harness = await createMissionHarness({ step, safetyIntervalMs: 0 })
    await harness.start()
    await harness.drain()

    const task = await harness.task('T02')
    expect(task.status).not.toBe('DONE')
    expect(task.status).toBe('BLOCKED')

    const attempts = await harness.attempts('T02')
    expect(attempts.length).toBeGreaterThanOrEqual(1)
    expect(attempts.every((attempt) => attempt.failureReason?.code === 'NO_CHANGES')).toBe(true)
    expect(attempts.every((attempt) => attempt.gateExecutions.length === 0)).toBe(true)

    // O relato fica gravado como informacao operacional — e nao decide nada.
    expect(attempts[0]?.claims?.summary).toContain('12 testes passando')
    expect(attempts[0]?.claims?.reportedFiles).toEqual(['src/catalogo.js'])
    expect(attempts[0]?.observation?.diffStat.files).toBe(0)

    const eventos = await harness.events()
    const done = eventos.filter((event) => event.type === 'task.done').map((event) => event.taskId)
    expect(done).not.toContain('T02')

    // Dependentes de T02 nao avancam por conta do relato de quem falhou.
    expect((await harness.task('T04')).status).not.toBe('DONE')
    expect((await harness.run()).status).toBe('BLOCKED')
  }, 120_000)
})

describe('escrita fora do escopo declarado', () => {
  it('reprova a tentativa, nao roda o gate e bloqueia na reincidencia', async () => {
    const step: StepFn = (context) => {
      if (context.kind === 'review') return review('PASS')
      if (context.taskId === 'T04') {
        // T04 declarou `touches: [src/precos.js]` e escreve em outro modulo.
        return pass('T04: precificacao entregue', {
          'src/inventario.js': 'export const invasao = true\n',
        })
      }
      return missionStep(context)
    }
    harness = await createMissionHarness({ step, safetyIntervalMs: 0 })
    await harness.start()
    await harness.drain()

    const task = await harness.task('T04')
    expect(task.status).toBe('BLOCKED')
    expect(task.blockage?.kind).toBe('POLICY')
    expect(task.blockage?.reason).toContain('SCOPE_VIOLATION')

    const attempts = await harness.attempts('T04')
    expect(attempts.length).toBeGreaterThanOrEqual(1)
    for (const attempt of attempts) {
      expect(attempt.failureReason?.code).toBe('SCOPE_VIOLATION')
      expect(attempt.observation?.scopeCheck).toBe('VIOLATION')
      expect(attempt.observation?.outOfScopePaths).toContain('src/inventario.js')
      // Gate nao roda sobre tentativa que ja violou a fronteira.
      expect(attempt.gateExecutions).toHaveLength(0)
      expect(attempt.review).toBeUndefined()
    }

    const eventos = await harness.events()
    const violacoes = eventos.filter((event) => event.type === 'policy.scope_violation')
    expect(violacoes.length).toBeGreaterThanOrEqual(1)
    expect(violacoes.every((event) => event.taskId === 'T04')).toBe(true)

    // Nada da T04 entra na branch da missao.
    const log = await harness.git('log', '--format=%s', 'mission/EXEMPLO-001')
    expect(log).not.toContain('T04 a')
    const arquivos = await harness.git('ls-tree', '-r', '--name-only', 'mission/EXEMPLO-001')
    expect(arquivos).not.toContain('src/precos.js')

    // As tasks independentes da T04 seguiram em frente: bloqueio nao para o mundo.
    const concluidas = (await harness.tasks()).filter((item) => item.status === 'DONE')
    expect(concluidas.map((item) => item.taskId)).toContain('T01')
  }, 120_000)
})

describe('evidencia de cada tentativa encerrada', () => {
  it('grava diff medido e commit proprio em toda tentativa aprovada', async () => {
    harness = await createMissionHarness({ safetyIntervalMs: 0 })
    await harness.start()
    await harness.drain()

    const attempts = await harness.attempts()
    expect(attempts).toHaveLength(8)
    for (const attempt of attempts) {
      const taskId = taskIdOf(attempt)
      expect(attempt.observation?.scopeCheck, taskId).toBe('PASS')
      expect(attempt.observation?.commit, taskId).toMatch(/^[0-9a-f]{40}$/)
      expect(attempt.observation?.diffStat.files, taskId).toBeGreaterThan(0)
      expect(attempt.observation?.outOfScopePaths, taskId).toEqual([])
      expect(attempt.durationMs, taskId).toBeGreaterThanOrEqual(0)
    }
  }, 120_000)
})
