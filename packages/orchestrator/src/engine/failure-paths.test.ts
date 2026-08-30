import { afterEach, describe, expect, it } from 'vitest'
import { pass, review, type StepFn } from './__fixtures__/agents.js'
import {
  GATE_ALWAYS_FAIL,
  GATE_ALWAYS_PASS,
  GATE_FIRST_ATTEMPT_FAILS,
} from './__fixtures__/files.js'
import { createHarness, type Harness } from './__fixtures__/harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

const writes = (taskId: string, attempt: number): Readonly<Record<string, string>> => ({
  [`packages/${taskId.toLowerCase()}/${taskId}.ts`]: `export const ${taskId} = ${attempt}\n`,
})

const executor: StepFn = (context) =>
  context.kind === 'review'
    ? review('PASS')
    : pass(
        `${context.taskId} tentativa ${context.attemptNumber}`,
        writes(context.taskId, context.attemptNumber),
      )

describe('gate reprovado', () => {
  it('retenta e conclui na segunda tentativa preservando o historico', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_FIRST_ATTEMPT_FAILS] },
      step: executor,
    })
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).toBe('DONE')
    expect(task.attemptCount).toBe(2)

    const attempts = await harness.attempts('T01')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.result).toBe('FAIL')
    expect(attempts[0]?.failureReason?.code).toBe('GATE_FAILED')
    expect(attempts[0]?.gateExecutions[0]?.status).toBe('FAIL')
    expect(attempts[1]?.result).toBe('PASS')
    expect(attempts[1]?.gateExecutions[0]?.status).toBe('PASS')

    const types = await harness.eventTypes()
    expect(types).toContain('task.retry_scheduled')
  }, 120_000)

  it('esgota tentativas e bloqueia com escalonamento, deixando o run BLOCKED', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 2,
        tasks: [{ id: 'T01' }],
      },
      gates: { unit: [GATE_ALWAYS_FAIL] },
      step: executor,
    })
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).toBe('BLOCKED')
    expect(task.attemptCount).toBe(2)
    expect(task.blockage?.kind).toBe('ATTEMPTS_EXHAUSTED')
    expect(task.blockage?.needs).toContain('2/2')

    const run = await harness.run()
    expect(run.status).toBe('BLOCKED')
    const types = await harness.eventTypes()
    expect(types).toContain('run.blocked')
    expect(types).not.toContain('task.done')
  }, 120_000)
})

describe('revisao', () => {
  it('reprova, retenta e conclui quando a segunda tentativa passa', async () => {
    harness = await createHarness({
      mission: { requireReview: true, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: (context) =>
        context.kind === 'review'
          ? review(context.attemptNumber === 1 ? 'FAIL' : 'PASS', 'diff insuficiente')
          : pass(
              `T01 tentativa ${context.attemptNumber}`,
              writes(context.taskId, context.attemptNumber),
            ),
    })
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).toBe('DONE')
    expect(task.attemptCount).toBe(2)

    const attempts = await harness.attempts('T01')
    expect(attempts[0]?.failureReason?.code).toBe('REVIEW_FAILED')
    expect(attempts[0]?.review?.verdict).toBe('FAIL')
    expect(attempts[1]?.review?.verdict).toBe('PASS')
    expect(attempts[1]?.review?.reviewer.sessionRef).not.toBe(attempts[1]?.executor.sessionRef)
  }, 120_000)

  it('escala para BLOCKED sem consumir novas tentativas', async () => {
    harness = await createHarness({
      mission: { requireReview: true, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: (context) =>
        context.kind === 'review'
          ? review('ESCALATE', 'ambiguidade arquitetural na fronteira')
          : pass('T01', writes(context.taskId, context.attemptNumber)),
    })
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).toBe('BLOCKED')
    expect(task.blockage?.kind).toBe('ARCHITECTURAL')
    expect(task.attemptCount).toBe(1)

    const types = await harness.eventTypes()
    expect(types).toContain('review.escalated')
    expect(types).not.toContain('task.retry_scheduled')
  }, 120_000)
})

describe('escopo declarado e contrato (P04)', () => {
  it('reprova sem rodar o gate e a reincidencia nao e retentavel', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 5,
        tasks: [{ id: 'T01', touches: ['packages/t01/'] }],
      },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: () =>
        pass('escrevi tudo certinho', {
          'packages/outra/invasao.ts': 'export const invasao = true\n',
        }),
    })
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).toBe('BLOCKED')
    expect(task.attemptCount).toBe(2)
    expect(task.blockage?.kind).toBe('POLICY')
    expect(task.blockage?.reason).toContain('SCOPE_VIOLATION')

    const attempts = await harness.attempts('T01')
    expect(attempts).toHaveLength(2)
    for (const attempt of attempts) {
      expect(attempt.failureReason?.code).toBe('SCOPE_VIOLATION')
      expect(attempt.observation?.scopeCheck).toBe('VIOLATION')
      expect(attempt.observation?.outOfScopePaths).toContain('packages/outra/invasao.ts')
      // Gate nao roda sobre tentativa que violou fronteira.
      expect(attempt.gateExecutions).toHaveLength(0)
    }

    const events = await harness.events()
    const violations = events.filter((event) => event.type === 'policy.scope_violation')
    expect(violations).toHaveLength(2)
    expect(
      violations.map((event) =>
        event.type === 'policy.scope_violation' ? event.payload.occurrence : 0,
      ),
    ).toEqual([1, 2])
  }, 120_000)
})

describe('claims nao decidem (P05 / ADR-0006)', () => {
  it('nao conclui a task quando o agente diz ter feito tudo e nao altera arquivo', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 2,
        tasks: [{ id: 'T01' }],
      },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: () => ({
        status: 'completed',
        claims: {
          summary: 'implementei tudo, 38 testes passaram',
          detail: 'cobertura completa, revisado por mim mesmo',
        },
      }),
    })
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).not.toBe('DONE')
    expect(task.status).toBe('BLOCKED')

    const attempts = await harness.attempts('T01')
    expect(attempts.every((attempt) => attempt.failureReason?.code === 'NO_CHANGES')).toBe(true)
    // O relato e persistido como informacao operacional...
    expect(attempts[0]?.claims?.summary).toBe('implementei tudo, 38 testes passaram')
    // ...e o fato medido o contradiz.
    expect(attempts[0]?.observation?.diffStat.files).toBe(0)

    const types = await harness.eventTypes()
    expect(types).not.toContain('task.done')
    expect(types).not.toContain('gate.started')
  }, 120_000)
})

describe('falha de fornecedor', () => {
  it('nao consome tentativa e vai direto para BLOCKED', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: () => ({
        status: 'failed',
        claims: { summary: 'nao deveria ser lido' },
        failWith: 'PROVIDER_UNAVAILABLE',
      }),
    })
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).toBe('BLOCKED')
    expect(task.attemptCount).toBe(0)
    expect(task.blockage?.kind).toBe('EXTERNAL')

    const attempts = await harness.attempts('T01')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.failureReason?.code).toBe('PROVIDER_UNAVAILABLE')
  }, 120_000)
})

describe('dependencia de task bloqueada', () => {
  it('mantem o dependente em PENDING e leva o run a BLOCKED por deadlock', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }, { id: 'T02', dependencies: ['T01'] }],
      },
      gates: { unit: [GATE_ALWAYS_FAIL] },
      step: executor,
    })
    await harness.orchestrator.drain()

    expect((await harness.task('T01')).status).toBe('BLOCKED')
    expect((await harness.task('T02')).status).toBe('PENDING')
    expect((await harness.run()).status).toBe('BLOCKED')
  }, 120_000)
})

describe('mission gate', () => {
  it('reprova a missao e leva o run a FAILED', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        missionGate: 'mission',
        tasks: [{ id: 'T01' }],
      },
      gates: { unit: [GATE_ALWAYS_PASS], mission: [GATE_ALWAYS_FAIL] },
      step: executor,
    })
    await harness.orchestrator.drain()

    expect((await harness.task('T01')).status).toBe('DONE')
    const run = await harness.run()
    expect(run.status).toBe('FAILED')
    expect(run.failureReason).toContain('mission gate')
    expect(run.missionGateExecutionId).toBeTypeOf('string')

    const types = await harness.eventTypes()
    expect(types).toContain('run.verifying')
    expect(types).toContain('run.failed')
    expect(types).not.toContain('run.completed')
  }, 120_000)

  it('conclui sem mission gate declarado', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: executor,
    })
    await harness.orchestrator.drain()
    expect((await harness.run()).status).toBe('COMPLETED')
  }, 120_000)
})
