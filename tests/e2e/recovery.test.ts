import type { Attempt, TaskRun } from '@agentic/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StepFn } from './support/agents.js'
import { missionStep, pass, review } from './support/agents.js'
import { ENTREGAS } from './support/entregas.js'
import { createMissionHarness, type MissionHarness } from './support/harness.js'
import { taskIdOf } from './support/outcome.js'

/**
 * Queda do control plane no meio do run. O que estava em voo nao vira conclusao presumida
 * nem tentativa duplicada: vira INTERRUPTED com registro, e o run continua.
 */

/** Agente lento: fica em voo enquanto o control plane cai. */
const lento: StepFn = (context) => {
  if (context.kind === 'review') return review('PASS')
  return pass(`${context.taskId}: entrega lenta`, ENTREGAS[context.taskId] ?? {}, 5_000)
}

let antes: MissionHarness
let depois: MissionHarness
let interrompido: { readonly tasks: readonly TaskRun[]; readonly attempts: readonly Attempt[] }

beforeAll(async () => {
  antes = await createMissionHarness({ step: lento, safetyIntervalMs: 0 })
  await antes.start()
  // Um tick despacha a primeira wave; o control plane cai antes de qualquer resultado.
  await antes.orchestrator.tick()
  interrompido = { tasks: await antes.tasks(), attempts: await antes.attempts() }

  depois = await antes.reopen(missionStep)
  await depois.drain()
}, 240_000)

afterAll(async () => {
  await depois?.cleanup()
})

describe('antes da queda', () => {
  it('deixa as tentativas da primeira wave abertas no banco', () => {
    const running = interrompido.tasks.filter((task) => task.status === 'RUNNING')
    expect(running.map((task) => task.taskId).sort()).toEqual(['T01', 'T02'])
    expect(interrompido.attempts).toHaveLength(2)
    for (const attempt of interrompido.attempts) {
      expect(attempt.finishedAt).toBeUndefined()
      expect(attempt.result).toBeUndefined()
      expect(attempt.gateExecutions).toHaveLength(0)
    }
  })
})

describe('depois de reabrir a partir do mesmo banco', () => {
  it('encerra as tentativas orfas como INTERRUPTED, sem presumir conclusao', async () => {
    const todas = await depois.attempts()
    const orfas = todas.filter((attempt) =>
      interrompido.attempts.some((antiga) => antiga.id === attempt.id),
    )
    expect(orfas).toHaveLength(2)
    for (const orfa of orfas) {
      expect(orfa.failureReason?.code, taskIdOf(orfa)).toBe('INTERRUPTED')
      expect(orfa.result, taskIdOf(orfa)).toBe('CANCELLED')
      expect(orfa.gateExecutions).toHaveLength(0)
      expect(orfa.review).toBeUndefined()
      expect(orfa.observation?.commit).toBeUndefined()
      expect(orfa.finishedAt).toBeInstanceOf(Date)
    }
  })

  it('registra o encerramento no log de eventos', async () => {
    const eventos = await depois.events()
    const falhas = eventos.filter(
      (event) => event.type === 'task.failed' && (event.taskId === 'T01' || event.taskId === 'T02'),
    )
    expect(falhas).toHaveLength(2)
    for (const falha of falhas) {
      expect(falha.type === 'task.failed' ? falha.payload.failure.code : '').toBe('INTERRUPTED')
    }
  })

  it('nao duplica tentativa: uma linha por despacho', async () => {
    const todas = await depois.attempts()
    const ids = todas.map((attempt) => attempt.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(todas.filter((attempt) => taskIdOf(attempt) === 'T01')).toHaveLength(2)
    expect(todas.filter((attempt) => taskIdOf(attempt) === 'T02')).toHaveLength(2)
    // 8 tasks, duas delas com a tentativa interrompida repetida.
    expect(todas).toHaveLength(10)
  })

  it('libera lock e workspace da tentativa orfa', async () => {
    const locks = await depois.plane.persistence.runs.listLocks(depois.runId)
    expect(locks).toHaveLength(0)
    const eventos = await depois.events()
    for (const antiga of interrompido.attempts) {
      const liberado = eventos.find(
        (event) => event.type === 'workspace.released' && event.attemptId === antiga.id,
      )
      expect(liberado, `workspace da tentativa ${antiga.id}`).toBeDefined()
    }
  })

  it('retoma o run e chega ao fim com todas as tasks DONE', async () => {
    const tasks = await depois.tasks()
    expect(tasks.map((task) => task.status)).toEqual(Array(8).fill('DONE'))
    const run = await depois.run()
    expect(run.status).toBe('COMPLETED')
    expect(run.missionGateExecutionId).toBeTypeOf('string')
  })

  it('cobra a tentativa interrompida do orcamento da task', async () => {
    expect((await depois.task('T01')).attemptCount).toBe(2)
    expect((await depois.task('T02')).attemptCount).toBe(2)
    const report = await depois.plane.generateMissionReport(depois.runId)
    expect(report.attempts).toBe(10)
    expect(report.retries).toBe(2)
    expect(report.tasks.done).toBe(8)
  })
})
