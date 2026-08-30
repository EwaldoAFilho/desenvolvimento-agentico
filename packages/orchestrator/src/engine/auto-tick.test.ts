import { afterEach, describe, expect, it } from 'vitest'
import { pass, review, type StepFn } from './__fixtures__/agents.js'
import { GATE_ALWAYS_PASS, GATE_FIRST_ATTEMPT_FAILS } from './__fixtures__/files.js'
import { createHarness, type Harness } from './__fixtures__/harness.js'

let harness: Harness | undefined

afterEach(async () => {
  harness?.orchestrator.stop()
  await harness?.cleanup()
  harness = undefined
})

const step: StepFn = (context) =>
  context.kind === 'review'
    ? review('PASS')
    : pass(`${context.taskId} tentativa ${context.attemptNumber}`, {
        [`packages/${context.taskId.toLowerCase()}/${context.taskId}.ts`]: `export const x = ${context.attemptNumber}\n`,
      })

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

describe('tick por evento e timer de seguranca (ARCHITECTURE 3.3)', () => {
  it('conclui a missao sem nenhum tick manual', async () => {
    harness = await createHarness({
      mission: {
        requireReview: true,
        defaultGate: 'unit',
        missionGate: 'mission',
        tasks: [{ id: 'T01' }, { id: 'T02', dependencies: ['T01'] }],
      },
      gates: { unit: [GATE_ALWAYS_PASS], mission: [GATE_ALWAYS_PASS] },
      step,
    })
    harness.orchestrator.start()

    const active = harness
    const completed = await waitFor(async () => (await active.run()).status === 'COMPLETED', 30_000)
    expect(completed).toBe(true)
    expect((await harness.tasks()).map((task) => task.status)).toEqual(['DONE', 'DONE'])
    expect(harness.orchestrator.errors).toEqual([])
  }, 60_000)

  it('destrava o backoff de RETRY, que depende do relogio e nao de um evento', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      // Backoff real: sem timer de seguranca nada acordaria o loop para promover o RETRY.
      project: { retryBackoffSeconds: 2 },
      gates: { unit: [GATE_FIRST_ATTEMPT_FAILS] },
      step,
    })
    harness.orchestrator.start()

    const active = harness
    const done = await waitFor(async () => (await active.task('T01')).status === 'DONE', 30_000)
    expect(done).toBe(true)
    expect((await harness.task('T01')).attemptCount).toBe(2)
  }, 60_000)
})
