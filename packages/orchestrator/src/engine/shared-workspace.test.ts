import { afterEach, describe, expect, it } from 'vitest'
import { pass, review, type StepFn } from './__fixtures__/agents.js'
import { GATE_ALWAYS_PASS } from './__fixtures__/files.js'
import { createHarness, type Harness } from './__fixtures__/harness.js'

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

describe('modo shared (ADR-0007)', () => {
  it('executa em serie na unica arvore e conclui a missao', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        missionGate: 'mission',
        tasks: [{ id: 'T01' }, { id: 'T02' }],
      },
      project: { workspace: 'shared', maxParallelTasks: 1, maxExecutors: 1 },
      gates: { unit: [GATE_ALWAYS_PASS], mission: [GATE_ALWAYS_PASS] },
      step,
    })
    await harness.orchestrator.drain()

    const tasks = await harness.tasks()
    expect(tasks.map((task) => task.status)).toEqual(['DONE', 'DONE'])
    expect((await harness.run()).status).toBe('COMPLETED')
    expect(harness.orchestrator.errors).toEqual([])
  }, 120_000)

  it('mede a tentativa na propria arvore do repositorio', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      project: { workspace: 'shared', maxParallelTasks: 1, maxExecutors: 1 },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step,
    })
    await harness.orchestrator.drain()

    const attempt = (await harness.attempts('T01'))[0]
    expect(attempt?.workspace.kind).toBe('shared')
    expect(attempt?.workspace.path).toBe(harness.root)
    expect(attempt?.observation?.scopeCheck).toBe('PASS')
    expect(attempt?.result).toBe('PASS')
    const head = await harness.git('log', '-1', '--format=%s')
    expect(head).toContain('T01 a1')
  }, 120_000)
})
