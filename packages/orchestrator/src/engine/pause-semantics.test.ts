import { afterEach, describe, expect, it } from 'vitest'
import type { StepFn } from './__fixtures__/agents.js'
import { GATE_ALWAYS_PASS, GATE_FIRST_ATTEMPT_FAILS } from './__fixtures__/files.js'
import { createHarness, DEFAULT_ACTOR, defaultStep, type Harness } from './__fixtures__/harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

const HUMAN = { actor: DEFAULT_ACTOR }

/** Agente lento o bastante para a pausa acontecer COM tentativa em voo. */
const slowStep: StepFn = (context) => ({ ...defaultStep(context), delayMs: 40 })

/**
 * Semantica de `pause`/`resume` exatamente como STATE-MACHINES 2.1 descreve:
 * pausado "nada novo e despachado, tentativas em voo terminam".
 *
 * O que estes testes cobrem e o caso que a interface expoe: pausar um run que ESTA
 * trabalhando. Nenhuma CLI de agente e nenhuma quota: o provider e o mock roteirizado.
 */
describe('pause com tentativa em voo', () => {
  it('deixa a tentativa em voo terminar e nao despacha mais nada', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        tasks: [{ id: 'T01' }, { id: 'T02' }],
      },
      // Uma vaga so: T02 fica esperando enquanto T01 trabalha.
      project: { maxParallelTasks: 1, maxExecutors: 1 },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: slowStep,
    })
    await harness.orchestrator.tick()
    expect(harness.orchestrator.inflightAttempts).toHaveLength(1)

    await harness.plane.pauseRun(harness.runId, { ...HUMAN, reason: 'preciso olhar o diff' })
    await harness.orchestrator.drain()

    expect((await harness.run()).status).toBe('PAUSED')
    // O que estava em voo chegou ao fim: pausar nao e matar.
    expect((await harness.task('T01')).status).toBe('DONE')
    // O que ainda nao tinha comecado nao comeca.
    expect((await harness.task('T02')).status).toBe('READY')
    expect(await harness.attempts()).toHaveLength(1)
  }, 120_000)

  it('nao cancela a tentativa: ela termina com desfecho normal', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: slowStep,
    })
    await harness.orchestrator.tick()
    await harness.plane.pauseRun(harness.runId, HUMAN)
    await harness.orchestrator.drain()

    const attempts = await harness.attempts('T01')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.result).not.toBe('CANCELLED')
    expect(attempts[0]?.failureReason).toBeUndefined()
    const types = await harness.eventTypes()
    expect(types).toContain('run.paused')
    expect(types).not.toContain('attempt.cancelled')
  }, 120_000)

  it('a revisao que a tentativa em voo exige ainda e despachada', async () => {
    harness = await createHarness({
      mission: { requireReview: true, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: slowStep,
    })
    await harness.orchestrator.tick()
    await harness.plane.pauseRun(harness.runId, HUMAN)
    await harness.orchestrator.drain()

    // Drenar antes de encher: uma tentativa em VERIFYING so termina com a revisao que pede.
    const types = await harness.eventTypes()
    expect(types.indexOf('run.paused')).toBeLessThan(types.indexOf('review.requested'))
    expect((await harness.task('T01')).status).toBe('DONE')
    expect(await harness.attempts()).toHaveLength(1)
  }, 120_000)

  it('nem a tentativa de retry e despachada enquanto o run esta pausado', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 2,
        tasks: [{ id: 'T01' }],
      },
      gates: { unit: [GATE_FIRST_ATTEMPT_FAILS] },
      step: slowStep,
    })
    await harness.orchestrator.tick()
    await harness.plane.pauseRun(harness.runId, HUMAN)
    await harness.orchestrator.drain()

    // A primeira tentativa reprovou no gate; a segunda NAO comeca com o run pausado.
    expect(await harness.attempts('T01')).toHaveLength(1)
    expect((await harness.task('T01')).status).not.toBe('DONE')

    await harness.plane.resumeRun(harness.runId, HUMAN)
    await harness.orchestrator.drain()

    // Retomar despacha a segunda tentativa — uma, nao duas.
    expect(await harness.attempts('T01')).toHaveLength(2)
    expect((await harness.task('T01')).status).toBe('DONE')
    expect((await harness.task('T01')).attemptCount).toBe(2)
  }, 120_000)
})

describe('resume volta a despachar sem duplicar tentativa', () => {
  it('a task que ja tinha terminado nao ganha tentativa nova', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        tasks: [{ id: 'T01' }, { id: 'T02' }],
      },
      project: { maxParallelTasks: 1, maxExecutors: 1 },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: slowStep,
    })
    await harness.orchestrator.tick()
    await harness.plane.pauseRun(harness.runId, HUMAN)
    await harness.orchestrator.drain()
    const beforeResume = await harness.attempts('T01')
    expect(beforeResume).toHaveLength(1)

    await harness.plane.resumeRun(harness.runId, HUMAN)
    await harness.orchestrator.drain()

    const afterResume = await harness.attempts('T01')
    expect(afterResume).toHaveLength(1)
    expect(afterResume[0]?.id).toBe(beforeResume[0]?.id)
    expect((await harness.task('T01')).attemptCount).toBe(1)
    // E o que estava esperando finalmente anda — com UMA tentativa.
    expect((await harness.task('T02')).status).toBe('DONE')
    expect(await harness.attempts('T02')).toHaveLength(1)
  }, 120_000)

  it('pausar e retomar duas vezes nao inventa tentativa nenhuma', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }],
      },
      project: { maxParallelTasks: 1, maxExecutors: 1 },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: slowStep,
    })

    for (let round = 0; round < 2; round += 1) {
      await harness.orchestrator.tick()
      await harness.plane.pauseRun(harness.runId, HUMAN)
      await harness.orchestrator.drain()
      expect((await harness.run()).status).toBe('PAUSED')
      await harness.plane.resumeRun(harness.runId, HUMAN)
    }
    await harness.orchestrator.drain()

    const tasks = await harness.tasks()
    expect(tasks.every((task) => task.status === 'DONE')).toBe(true)
    // Uma tentativa por task: a contagem e a prova de que nada foi refeito.
    expect(await harness.attempts()).toHaveLength(3)
    expect(tasks.every((task) => task.attemptCount === 1)).toBe(true)
  }, 120_000)
})
