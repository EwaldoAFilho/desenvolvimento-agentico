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
    ? review('PASS', `revisado por ${context.providerId}`)
    : pass(`${context.taskId} pronto`, {
        [`packages/${context.taskId.toLowerCase()}/${context.taskId}.ts`]: 'export const x = 1\n',
      })

const TWO_PROVIDERS = [
  { id: 'mock', maxConcurrent: 2 },
  { id: 'mock-alt', maxConcurrent: 2 },
]

describe('politica de revisao (ADR-0011)', () => {
  it('nunca deixa o executor revisar a propria tentativa (I3)', async () => {
    harness = await createHarness({
      mission: { requireReview: true, defaultGate: 'unit', tasks: [{ id: 'T01' }, { id: 'T02' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step,
    })
    await harness.orchestrator.drain()

    const attempts = await harness.attempts()
    expect(attempts).toHaveLength(2)
    for (const attempt of attempts) {
      expect(attempt.review?.verdict).toBe('PASS')
      expect(attempt.review?.reviewer.sessionRef).not.toBe(attempt.executor.sessionRef)
    }
    // `sessionRef` e a chave de identidade (DOMAIN-MODEL 3.5): duas revisoes sao duas
    // sessoes, nunca a mesma identidade reaproveitada.
    const sessions = attempts.map((attempt) => attempt.review?.reviewer.sessionRef)
    expect(new Set(sessions).size).toBe(2)
  }, 120_000)

  it('usa revisor de outro fornecedor quando a politica exige revisao cruzada', async () => {
    harness = await createHarness({
      mission: {
        requireReview: true,
        defaultGate: 'unit',
        tasks: [{ id: 'T01', risk: 'high' }],
      },
      project: { providers: TWO_PROVIDERS },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step,
    })
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).toBe('DONE')
    const attempt = (await harness.attempts('T01'))[0]
    expect(attempt?.review?.policy).toBe('cross-provider-required')
    expect(attempt?.review?.policyOutcome).toBe('satisfied')
    expect(attempt?.review?.reviewer.providerId).not.toBe(attempt?.executor.providerId)
  }, 120_000)

  it('bloqueia com CROSS_PROVIDER_UNAVAILABLE em vez de rebaixar em silencio (I10)', async () => {
    harness = await createHarness({
      mission: {
        requireReview: true,
        defaultGate: 'unit',
        tasks: [{ id: 'T01', risk: 'high' }],
      },
      project: { providers: [{ id: 'mock', maxConcurrent: 2 }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step,
    })
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).toBe('BLOCKED')
    expect(task.blockage?.kind).toBe('POLICY')
    expect(task.blockage?.reason).toBe('CROSS_PROVIDER_UNAVAILABLE')

    const attempt = (await harness.attempts('T01'))[0]
    expect(attempt?.review).toBeUndefined()
    const types = await harness.eventTypes()
    expect(types).not.toContain('review.policy_downgraded')
    expect(types).not.toContain('review.finished')
    expect((await harness.run()).status).toBe('BLOCKED')
  }, 120_000)

  it('rebaixa cross-provider-preferred somente com registro explicito', async () => {
    harness = await createHarness({
      mission: {
        requireReview: true,
        defaultGate: 'unit',
        tasks: [{ id: 'T01', reviewPolicy: 'cross-provider-preferred' }],
      },
      project: { providers: [{ id: 'mock', maxConcurrent: 2 }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step,
    })
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).toBe('DONE')
    const attempt = (await harness.attempts('T01'))[0]
    expect(attempt?.review?.policyOutcome).toBe('downgraded')

    const events = await harness.events()
    const downgrade = events.find((event) => event.type === 'review.policy_downgraded')
    expect(downgrade).toBeDefined()
    expect(downgrade?.type === 'review.policy_downgraded' ? downgrade.payload.to : '').toBe(
      'fresh-session',
    )
  }, 120_000)

  it('entrega ao revisor evidencia e nunca a narrativa do executor (P07)', async () => {
    const seen: string[] = []
    harness = await createHarness({
      mission: { requireReview: true, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: (context) => {
        if (context.kind === 'review') {
          seen.push(context.workspacePath)
          return review('PASS')
        }
        return pass('narrativa exclusiva do executor que nao pode vazar', {
          'packages/t01/T01.ts': 'export const x = 1\n',
        })
      },
    })
    await harness.orchestrator.drain()

    // O revisor trabalha na mesma worktree da tentativa, com sessao nova.
    expect(seen[0]).toContain('T01-a1')
    const attempt = (await harness.attempts('T01'))[0]
    expect(attempt?.claims?.summary).toContain('narrativa exclusiva')
    expect(JSON.stringify(attempt?.review?.input)).not.toContain('narrativa exclusiva')
  }, 120_000)
})
