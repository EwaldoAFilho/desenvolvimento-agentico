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

const quick: StepFn = (context) =>
  pass(`${context.taskId} pronto`, {
    [`packages/${context.taskId.toLowerCase()}/${context.taskId}.ts`]: 'export const x = 1\n',
  })

const slow: StepFn = (context) =>
  context.kind === 'review' ? review('PASS') : { ...quick(context), delayMs: 5_000 }

describe('reconciliacao apos reabrir o control plane', () => {
  it('conta a autorizacao humana uma unica vez, mesmo antes do primeiro tick (I4)', async () => {
    const first = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      gates: { unit: [GATE_ALWAYS_FAIL] },
      step: quick,
    })
    await first.orchestrator.drain()
    expect((await first.task('T01')).attemptCount).toBe(1)

    // Control plane novo: o humano destrava ANTES de qualquer tick do novo orquestrador.
    const reopened = await first.reopen()
    harness = reopened
    await reopened.plane.unblockTask(reopened.runId, {
      taskId: toTaskId('T01'),
      actor: DEFAULT_ACTOR,
      note: 'ajustei o ambiente do gate',
    })
    await reopened.orchestrator.drain()

    // Uma nota humana autoriza UMA tentativa a mais — nunca duas.
    expect((await reopened.task('T01')).attemptCount).toBe(2)
  }, 120_000)

  it('libera no banco os locks da tentativa orfa que nao volta a ser despachada', async () => {
    const first = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: slow,
    })
    await first.orchestrator.tick()
    const before = await first.plane.persistence.runs.listLocks(first.runId)
    expect(before).toHaveLength(1)

    const reopened = await first.reopen(slow)
    harness = reopened
    await reopened.orchestrator.tick()

    expect((await reopened.task('T01')).status).toBe('BLOCKED')
    expect(await reopened.plane.persistence.runs.listLocks(reopened.runId)).toEqual([])
  }, 120_000)
})
