import { taskId as toTaskId } from '@agentic/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { pass, review, type StepFn } from './__fixtures__/agents.js'
import { GATE_ALWAYS_FAIL, GATE_ALWAYS_PASS } from './__fixtures__/files.js'
import { createHarness, DEFAULT_ACTOR, type Harness } from './__fixtures__/harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

const step: StepFn = (context) =>
  context.kind === 'review'
    ? review('PASS')
    : pass(`${context.taskId} pronto`, {
        [`packages/${context.taskId.toLowerCase()}/${context.taskId}.ts`]: 'export const x = 1\n',
      })

const HUMAN = { actor: DEFAULT_ACTOR }

describe('comandos humanos sobre o run', () => {
  it('pausa sem despachar nada novo e retoma ate concluir', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step,
    })
    await harness.plane.pauseRun(harness.runId, { ...HUMAN, reason: 'janela de manutencao' })
    await harness.orchestrator.tick()

    expect((await harness.run()).status).toBe('PAUSED')
    expect(await harness.attempts()).toHaveLength(0)
    expect((await harness.task('T01')).status).toBe('READY')

    await harness.plane.resumeRun(harness.runId, HUMAN)
    await harness.orchestrator.drain()
    expect((await harness.task('T01')).status).toBe('DONE')
    const types = await harness.eventTypes()
    expect(types).toContain('run.paused')
    expect(types).toContain('run.resumed')
  }, 120_000)

  it('cancela o run inteiro e nao presume nada concluido', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }, { id: 'T02' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: (context) => ({ ...step(context), delayMs: 5_000 }),
    })
    await harness.orchestrator.tick()
    await harness.plane.stopRun(harness.runId, { ...HUMAN, reason: 'prioridade mudou' })

    const run = await harness.run()
    expect(run.status).toBe('CANCELLED')
    const tasks = await harness.tasks()
    expect(tasks.every((task) => task.status === 'CANCELLED')).toBe(true)
    const types = await harness.eventTypes()
    expect(types).toContain('human.run_cancelled')
    expect(types).toContain('attempt.cancelled')
    expect(types).not.toContain('task.done')

    // Nenhuma tentativa fica aberta fingindo que ainda executa (P11).
    const attempts = await harness.attempts()
    expect(attempts.length).toBeGreaterThan(0)
    for (const attempt of attempts) {
      expect(attempt.result).toBe('CANCELLED')
      expect(attempt.failureReason?.code).toBe('INTERRUPTED')
      expect(attempt.finishedAt).toBeInstanceOf(Date)
    }
  }, 120_000)

  it('impede COMPLETED quando ha task cancelada', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        missionGate: 'mission',
        tasks: [{ id: 'T01' }, { id: 'T02' }],
      },
      gates: { unit: [GATE_ALWAYS_PASS], mission: [GATE_ALWAYS_PASS] },
      step,
    })
    await harness.plane.cancelTask(harness.runId, {
      taskId: toTaskId('T02'),
      actor: DEFAULT_ACTOR,
      reason: 'fora do escopo desta entrega',
    })
    await harness.orchestrator.drain()

    const run = await harness.run()
    expect(run.status).toBe('FAILED')
    expect(run.failureReason).toContain('CANCELLED')
    expect((await harness.task('T01')).status).toBe('DONE')
  }, 120_000)
})

describe('comandos humanos sobre a task', () => {
  it('exige nota para destravar e concede tentativa extra autorizada', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      gates: { unit: [GATE_ALWAYS_FAIL] },
      step,
    })
    await harness.orchestrator.drain()
    expect((await harness.task('T01')).status).toBe('BLOCKED')

    await expect(
      harness.plane.unblockTask(harness.runId, {
        taskId: toTaskId('T01'),
        actor: DEFAULT_ACTOR,
        note: '   ',
      }),
    ).rejects.toThrow(/unblock recusado/)

    await harness.plane.unblockTask(harness.runId, {
      taskId: toTaskId('T01'),
      actor: DEFAULT_ACTOR,
      note: 'ajustei o ambiente do gate',
    })
    expect((await harness.task('T01')).status).toBe('READY')

    await harness.orchestrator.drain()
    const task = await harness.task('T01')
    // A autorizacao humana rendeu exatamente uma tentativa a mais.
    expect(task.attemptCount).toBe(2)
    expect(task.status).toBe('BLOCKED')
    const types = await harness.eventTypes()
    expect(types).toContain('human.task_unblocked')
  }, 120_000)

  it('exige motivo para pular e libera o dependente', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }, { id: 'T02', dependencies: ['T01'] }],
      },
      gates: { unit: [GATE_ALWAYS_FAIL] },
      step,
    })
    await harness.orchestrator.drain()
    expect((await harness.task('T01')).status).toBe('BLOCKED')

    await expect(
      harness.plane.skipTask(harness.runId, {
        taskId: toTaskId('T01'),
        actor: DEFAULT_ACTOR,
        reason: '',
      }),
    ).rejects.toThrow(/skip recusado/)

    await harness.plane.skipTask(harness.runId, {
      taskId: toTaskId('T01'),
      actor: DEFAULT_ACTOR,
      reason: 'entrega manual ja aplicada',
    })
    await harness.orchestrator.tick()
    expect((await harness.task('T01')).status).toBe('SKIPPED')
    expect((await harness.task('T02')).status).not.toBe('PENDING')
    const types = await harness.eventTypes()
    expect(types).toContain('human.task_skipped')
  }, 120_000)

  it('retry manual reabre a task bloqueada com registro do autor', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      gates: { unit: [GATE_ALWAYS_FAIL] },
      step,
    })
    await harness.orchestrator.drain()
    await harness.plane.retryTask(harness.runId, { taskId: toTaskId('T01'), actor: DEFAULT_ACTOR })

    expect((await harness.task('T01')).status).toBe('READY')
    const events = await harness.events()
    const unblocked = events.find((event) => event.type === 'human.task_unblocked')
    expect(unblocked?.type === 'human.task_unblocked' ? unblocked.payload.actor : '').toBe(
      DEFAULT_ACTOR,
    )
  }, 120_000)

  it('recusa comando para task inexistente', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step,
    })
    await expect(
      harness.plane.skipTask(harness.runId, {
        taskId: toTaskId('T09'),
        actor: DEFAULT_ACTOR,
        reason: 'nao existe',
      }),
    ).rejects.toThrow(/T09/)
  }, 120_000)
})
