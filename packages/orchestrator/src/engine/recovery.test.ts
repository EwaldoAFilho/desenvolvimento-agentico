import type { Attempt, TaskRun } from '@agentic/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pass, review, type StepFn } from './__fixtures__/agents.js'
import { GATE_ALWAYS_PASS } from './__fixtures__/files.js'
import { createHarness, type Harness } from './__fixtures__/harness.js'

const slow: StepFn = (context) =>
  context.kind === 'review'
    ? review('PASS')
    : {
        ...pass(`${context.taskId} lento`, {
          [`packages/${context.taskId.toLowerCase()}/${context.taskId}.ts`]: 'export const x = 1\n',
        }),
        delayMs: 5_000,
      }

const quick: StepFn = (context) =>
  context.kind === 'review'
    ? review('PASS')
    : pass(`${context.taskId} rapido`, {
        [`packages/${context.taskId.toLowerCase()}/${context.taskId}.ts`]: 'export const x = 2\n',
      })

let first: Harness
let second: Harness
let interrupted: { readonly tasks: readonly TaskRun[]; readonly attempts: readonly Attempt[] }

beforeAll(async () => {
  first = await createHarness({
    mission: {
      requireReview: false,
      defaultGate: 'unit',
      tasks: [{ id: 'T01' }, { id: 'T02', dependencies: ['T01'] }],
    },
    gates: { unit: [GATE_ALWAYS_PASS] },
    step: slow,
  })
  // Um tick despacha a tentativa; o control plane cai antes de qualquer resultado chegar.
  await first.orchestrator.tick()
  interrupted = { tasks: await first.tasks(), attempts: await first.attempts() }

  second = await first.reopen(quick)
  await second.orchestrator.drain()
}, 180_000)

afterAll(async () => {
  await second?.cleanup()
})

describe('recovery apos queda do control plane', () => {
  it('deixa a tentativa em voo aberta no banco antes da queda', () => {
    expect(interrupted.tasks.find((task) => task.taskId === 'T01')?.status).toBe('RUNNING')
    expect(interrupted.attempts).toHaveLength(1)
    expect(interrupted.attempts[0]?.finishedAt).toBeUndefined()
    expect(interrupted.attempts[0]?.result).toBeUndefined()
  })

  it('encerra a tentativa orfa como INTERRUPTED, sem presumir conclusao', async () => {
    const attempts = await second.attempts('T01')
    const orphan = attempts[0]
    expect(orphan?.id).toBe(interrupted.attempts[0]?.id)
    expect(orphan?.failureReason?.code).toBe('INTERRUPTED')
    expect(orphan?.result).toBe('CANCELLED')
    expect(orphan?.gateExecutions).toHaveLength(0)
    expect(orphan?.review).toBeUndefined()
  })

  it('nao duplica tentativa: uma linha por despacho', async () => {
    const all = await second.attempts()
    const t01 = all.filter((attempt) => attempt.taskRunId.endsWith(':T01'))
    expect(t01).toHaveLength(2)
    expect(t01[1]?.attemptNumber).toBe(2)
    expect(new Set(all.map((attempt) => attempt.id)).size).toBe(all.length)
  })

  it('registra o encerramento da tentativa orfa no log', async () => {
    const events = await second.events()
    const failure = events.find((event) => event.type === 'task.failed' && event.taskId === 'T01')
    expect(failure?.type === 'task.failed' ? failure.payload.failure.code : '').toBe('INTERRUPTED')
  })

  it('retoma o run e chega a COMPLETED', async () => {
    const tasks = await second.tasks()
    expect(tasks.map((task) => task.status)).toEqual(['DONE', 'DONE'])
    expect((await second.run()).status).toBe('COMPLETED')
  })

  it('conta a tentativa interrompida no orcamento da task', async () => {
    const task = await second.task('T01')
    expect(task.attemptCount).toBe(2)
  })

  it('libera o lock e o workspace da tentativa orfa', async () => {
    const locks = await second.plane.persistence.runs.listLocks(second.runId)
    expect(locks).toHaveLength(0)
    const events = await second.events()
    const released = events.find(
      (event) =>
        event.type === 'workspace.released' && event.attemptId === interrupted.attempts[0]?.id,
    )
    expect(released).toBeDefined()
  })
})
