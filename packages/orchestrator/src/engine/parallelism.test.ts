import type { DomainEvent } from '@agentic/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { ConcurrencyProbe, pass, review } from './__fixtures__/agents.js'
import { GATE_ALWAYS_PASS } from './__fixtures__/files.js'
import { createHarness, type Harness } from './__fixtures__/harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

interface Window {
  readonly taskId: string
  readonly start: number
  readonly end: number
}

/** Janela de execucao de cada tentativa, medida pelos eventos — nao pelo relato do agente. */
function windows(events: readonly DomainEvent[]): Window[] {
  const out: Window[] = []
  for (const event of events) {
    if (event.type !== 'task.dispatched' || event.taskId === undefined) continue
    const end = events.find(
      (candidate) =>
        candidate.seq > event.seq &&
        candidate.taskId === event.taskId &&
        candidate.type === 'attempt.observed',
    )
    out.push({ taskId: event.taskId, start: event.seq, end: end?.seq ?? Number.MAX_SAFE_INTEGER })
  }
  return out
}

function overlap(left: Window, right: Window): boolean {
  return left.start < right.end && right.start < left.end
}

const slowStep =
  (delayMs: number) => (context: { taskId: string; kind: string; attemptNumber: number }) =>
    context.kind === 'review'
      ? review('PASS')
      : {
          ...pass(`${context.taskId} pronto`, {
            [`packages/${context.taskId.toLowerCase()}/x.ts`]: `export const x = '${context.taskId}'\n`,
          }),
          delayMs,
        }

describe('paralelismo real', () => {
  it('executa duas tasks independentes ao mesmo tempo', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        tasks: [{ id: 'T01' }, { id: 'T02' }],
      },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: slowStep(40),
    })
    await harness.orchestrator.drain()

    const events = await harness.events()
    const measured = windows(events)
    expect(measured).toHaveLength(2)
    const [first, second] = measured
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (first === undefined || second === undefined) return
    expect(overlap(first, second)).toBe(true)
    const tasks = await harness.tasks()
    expect(tasks.every((task) => task.status === 'DONE')).toBe(true)
  }, 120_000)

  it('nunca executa junto duas tasks com touches sobrepostos (I2)', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        tasks: [
          { id: 'T01', touches: ['packages/shared/'] },
          { id: 'T02', touches: ['packages/shared/'] },
        ],
      },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: (context) =>
        pass(`${context.taskId} pronto`, {
          [`packages/shared/${context.taskId}.ts`]: `export const ${context.taskId} = 1\n`,
        }),
    })
    await harness.orchestrator.drain()

    const measured = windows(await harness.events())
    expect(measured).toHaveLength(2)
    const [first, second] = measured
    if (first === undefined || second === undefined) throw new Error('faltou janela')
    expect(overlap(first, second)).toBe(false)
    const tasks = await harness.tasks()
    expect(tasks.every((task) => task.status === 'DONE')).toBe(true)
  }, 120_000)

  it('nao despacha mais do que o maxConcurrent do provider (I9)', async () => {
    const probe = new ConcurrencyProbe()
    harness = await createHarness({
      probe,
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }],
      },
      project: { providers: [{ id: 'mock', maxConcurrent: 1 }], maxParallelTasks: 3 },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: slowStep(20),
    })
    await harness.orchestrator.drain()

    expect(probe.maxOf('mock')).toBe(1)
    const tasks = await harness.tasks()
    expect(tasks.every((task) => task.status === 'DONE')).toBe(true)
  }, 120_000)

  it('respeita o teto global de paralelismo do run', async () => {
    const probe = new ConcurrencyProbe()
    harness = await createHarness({
      probe,
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }, { id: 'T04' }],
      },
      project: {
        maxParallelTasks: 2,
        maxExecutors: 2,
        providers: [{ id: 'mock', maxConcurrent: 4 }],
      },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: slowStep(30),
    })
    await harness.orchestrator.drain()

    expect(probe.max).toBeLessThanOrEqual(2)
    const tasks = await harness.tasks()
    expect(tasks.every((task) => task.status === 'DONE')).toBe(true)
  }, 120_000)
})
