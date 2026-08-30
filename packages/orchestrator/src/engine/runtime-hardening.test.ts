import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Attempt } from '@agentic/domain'
import { taskId as toTaskId } from '@agentic/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { brokenHandleFactory } from './__fixtures__/agents.js'
import { createFakeCli, type FakeCli } from './__fixtures__/fake-cli.js'
import { GATE_ALWAYS_PASS } from './__fixtures__/files.js'
import { createHarness, DEFAULT_ACTOR, defaultStep, type Harness } from './__fixtures__/harness.js'

let harness: Harness | undefined
let cli: FakeCli | undefined

afterEach(async () => {
  await harness?.cleanup()
  await cli?.cleanup()
  harness = undefined
  cli = undefined
})

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Um provider so no registry: `running` dele e a capacidade do fornecedor (I9). */
const runningOf = (current: Harness, id = 'local'): number =>
  current.plane.registry.capacity().byProvider[id]?.running ?? -1

const lastAttempt = (attempts: readonly Attempt[]): Attempt => {
  const found = attempts[attempts.length - 1]
  if (found === undefined) throw new Error('nenhuma tentativa registrada')
  return found
}

const oneProvider = (maxConcurrent = 2) => ({
  providers: [{ id: 'local', maxConcurrent }],
  maxParallelTasks: maxConcurrent,
  maxExecutors: maxConcurrent,
})

describe('processo do agente morto abruptamente', () => {
  it('vira falha classificada, sem DONE e sem RUNNING preso', async () => {
    cli = await createFakeCli({ default: { kind: 'kill' } })
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      project: oneProvider(),
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
    })
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).not.toBe('DONE')
    expect(task.status).not.toBe('RUNNING')
    expect(task.status).toBe('BLOCKED')

    const attempt = lastAttempt(await harness.attempts('T01'))
    expect(attempt.result).toBe('ERROR')
    expect(attempt.failureReason?.code).toBe('AGENT_ERROR')
    expect(attempt.finishedAt).toBeDefined()
    expect(attempt.gateExecutions).toHaveLength(0)
  }, 120_000)

  it('devolve a capacidade e libera o lock do escopo', async () => {
    cli = await createFakeCli({ default: { kind: 'kill' } })
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      project: oneProvider(),
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
    })
    await harness.orchestrator.drain()

    expect(runningOf(harness)).toBe(0)
    expect(await harness.plane.persistence.runs.listLocks(harness.runId)).toEqual([])
  }, 120_000)

  it('preserva a worktree da tentativa e deixa a referencia registrada', async () => {
    cli = await createFakeCli({ default: { kind: 'kill' } })
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      project: oneProvider(),
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
    })
    await harness.orchestrator.drain()

    const attempt = lastAttempt(await harness.attempts('T01'))
    // Referenciavel: a tentativa guarda o caminho, e o caminho continua existindo.
    expect(attempt.workspace.path).toContain('T01-a1')
    expect(existsSync(attempt.workspace.path)).toBe(true)

    const released = (await harness.events()).find(
      (event) => event.type === 'workspace.released' && event.attemptId === attempt.id,
    )
    expect(released?.type === 'workspace.released' ? released.payload.disposition : '').toBe('keep')
  }, 120_000)
})

describe('CLI que sai com codigo diferente de zero', () => {
  it('reprova como AGENT_ERROR e nunca conclui a task', async () => {
    cli = await createFakeCli({ default: { kind: 'exit', exitCode: 3 } })
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      project: oneProvider(),
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
    })
    await harness.orchestrator.drain()

    const attempt = lastAttempt(await harness.attempts('T01'))
    expect(attempt.result).toBe('ERROR')
    expect(attempt.failureReason?.code).toBe('AGENT_ERROR')
    expect((await harness.task('T01')).status).toBe('BLOCKED')
    expect((await harness.run()).status).not.toBe('COMPLETED')
  }, 120_000)

  it('registra o codigo de saida no relato quando a CLI nao diz mais nada', async () => {
    cli = await createFakeCli({ default: { kind: 'exit', exitCode: 17, silent: true } })
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      project: oneProvider(),
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
    })
    await harness.orchestrator.drain()

    const attempt = lastAttempt(await harness.attempts('T01'))
    expect(attempt.claims?.summary ?? '').toContain('17')
    expect(attempt.failureReason?.code).toBe('AGENT_ERROR')
  }, 120_000)

  it('guarda o que a CLI escreveu sem deixar o relato decidir a transicao', async () => {
    cli = await createFakeCli({ default: { kind: 'exit', exitCode: 2, write: true } })
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      project: oneProvider(),
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
    })
    await harness.orchestrator.drain()

    const attempt = lastAttempt(await harness.attempts('T01'))
    // A CLI ate alterou arquivo; o exit code e que decide, e ele reprova (P05).
    expect(attempt.observation?.diffStat.files ?? 0).toBeGreaterThan(0)
    expect(attempt.failureReason?.code).toBe('AGENT_ERROR')
    expect((await harness.task('T01')).status).not.toBe('DONE')
  }, 120_000)
})

describe('timeout da tentativa', () => {
  it('vira AGENT_TIMEOUT, mata a arvore de processos e devolve a capacidade', async () => {
    const target = join(
      process.env.TMPDIR ?? '/tmp',
      `agentic-neto-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    )
    cli = await createFakeCli({
      default: { kind: 'hang', grandchildTarget: target, grandchildDelayMs: 2_500 },
    })
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      project: { ...oneProvider(), attemptTimeoutMinutes: 0.02 },
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
    })
    await harness.orchestrator.drain()

    const attempt = lastAttempt(await harness.attempts('T01'))
    expect(attempt.result).toBe('TIMEOUT')
    expect(attempt.failureReason?.code).toBe('AGENT_TIMEOUT')
    expect((await harness.task('T01')).status).toBe('BLOCKED')
    expect(runningOf(harness)).toBe(0)

    // O neto so escreveria depois do prazo: se a arvore morreu, o arquivo nunca aparece.
    await delay(3_000)
    expect(existsSync(target)).toBe(false)
  }, 120_000)
})

describe('cancelamento humano', () => {
  it('produz status proprio, distinto de timeout e de erro do agente', async () => {
    cli = await createFakeCli({ default: { kind: 'hang' } })
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      project: oneProvider(),
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
    })
    await harness.orchestrator.tick()
    expect((await harness.task('T01')).status).toBe('RUNNING')

    await harness.plane.cancelTask(harness.runId, {
      taskId: toTaskId('T01'),
      actor: DEFAULT_ACTOR,
      reason: 'mudei de ideia',
    })

    const task = await harness.task('T01')
    expect(task.status).toBe('CANCELLED')
    const attempt = lastAttempt(await harness.attempts('T01'))
    expect(attempt.result).toBe('CANCELLED')
    expect(attempt.failureReason?.code).toBe('INTERRUPTED')
    // Tres desfechos, tres codigos: CANCELLED != TIMEOUT != ERROR.
    expect(attempt.result).not.toBe('TIMEOUT')
    expect(attempt.result).not.toBe('ERROR')
    expect(runningOf(harness)).toBe(0)
    expect(await harness.plane.persistence.runs.listLocks(harness.runId)).toEqual([])
  }, 120_000)
})

describe('saida volumosa da CLI', () => {
  it('nao trava o run: a task chega a DONE com o relato limitado', async () => {
    cli = await createFakeCli({
      default: { kind: 'noisy', stdoutBytes: 2 * 1024 * 1024, stderrBytes: 2 * 1024 * 1024 },
    })
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      project: oneProvider(),
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
    })
    await harness.orchestrator.drain()

    expect((await harness.task('T01')).status).toBe('DONE')
    const attempt = lastAttempt(await harness.attempts('T01'))
    const claims = attempt.claims
    expect(claims).toBeDefined()
    // O relato e limitado por construcao: 4 MiB de saida nao viram 4 MiB de estado.
    expect((claims?.summary ?? '').length).toBeLessThanOrEqual(410)
    expect((claims?.detail ?? '').length).toBeLessThanOrEqual(8_010)
    expect(runningOf(harness)).toBe(0)
  }, 120_000)

  it('saida volumosa antes de um exit != 0 continua reprovando', async () => {
    cli = await createFakeCli({
      default: { kind: 'exit', exitCode: 5, stdoutBytes: 1024 * 1024 },
    })
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      project: oneProvider(),
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
    })
    await harness.orchestrator.drain()

    const attempt = lastAttempt(await harness.attempts('T01'))
    expect(attempt.failureReason?.code).toBe('AGENT_ERROR')
    expect((await harness.task('T01')).status).not.toBe('DONE')
  }, 120_000)
})

describe('capacidade devolvida apos a morte do processo', () => {
  it('libera a vaga do fornecedor e uma nova task e despachada no lugar', async () => {
    cli = await createFakeCli({
      T01: { kind: 'kill', delayMs: 300 },
      T02: { kind: 'ok' },
    })
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }, { id: 'T02' }],
      },
      // Uma vaga so: enquanto T01 estiver viva, T02 nao tem por onde entrar (I9).
      project: oneProvider(1),
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
    })

    await harness.orchestrator.tick()
    expect((await harness.task('T01')).status).toBe('RUNNING')
    expect(runningOf(harness)).toBe(1)
    expect((await harness.task('T02')).status).not.toBe('RUNNING')

    await harness.orchestrator.drain()

    expect(runningOf(harness)).toBe(0)
    expect((await harness.task('T01')).status).toBe('BLOCKED')
    // A prova: sem a vaga de volta, T02 jamais teria sido despachada.
    expect((await harness.task('T02')).status).toBe('DONE')
    const dispatched = (await harness.events()).filter((event) => event.type === 'task.dispatched')
    expect(dispatched.map((event) => event.taskId)).toEqual(['T01', 'T02'])
  }, 120_000)
})

describe('lock orfao apos a queda do control plane', () => {
  it('reabrir libera o lock e a task que divide o escopo volta a ser despachavel', async () => {
    cli = await createFakeCli({
      T01: { kind: 'hang' },
      T02: { kind: 'ok', writePath: 'packages/shared/T02.ts' },
    })
    const first = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [
          { id: 'T01', touches: ['packages/shared/'] },
          { id: 'T02', touches: ['packages/shared/'] },
        ],
      },
      project: oneProvider(2),
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
    })
    await first.orchestrator.tick()

    const held = await first.plane.persistence.runs.listLocks(first.runId)
    expect(held).toHaveLength(1)
    expect((await first.task('T02')).status).not.toBe('RUNNING')

    const reopened = await first.reopen()
    harness = reopened
    await reopened.orchestrator.drain()

    // O lock orfao nao sobrevive a reabertura, senao T02 ficaria presa para sempre (I2).
    expect(await reopened.plane.persistence.runs.listLocks(reopened.runId)).toEqual([])
    expect((await reopened.task('T01')).status).toBe('BLOCKED')
    expect((await reopened.task('T02')).status).toBe('DONE')

    const orphan = lastAttempt(await reopened.attempts('T01'))
    expect(orphan.failureReason?.code).toBe('INTERRUPTED')
    expect(orphan.result).toBe('CANCELLED')
  }, 120_000)
})

describe('handle do fornecedor que morre sem desfecho', () => {
  it('nao perde a tentativa do executor: reprova, solta lock e vaga', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      project: oneProvider(),
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: brokenHandleFactory('execute'),
    })
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).not.toBe('RUNNING')
    expect(task.status).not.toBe('DONE')
    expect(task.status).toBe('BLOCKED')

    const attempt = lastAttempt(await harness.attempts('T01'))
    expect(attempt.result).toBe('ERROR')
    expect(attempt.failureReason?.code).toBe('AGENT_ERROR')
    expect(attempt.finishedAt).toBeDefined()
    // Nada em voo na memoria: a tentativa nao virou orfa dentro do processo vivo.
    expect(harness.orchestrator.inflightAttempts).toEqual([])
    expect(runningOf(harness)).toBe(0)
    expect(await harness.plane.persistence.runs.listLocks(harness.runId)).toEqual([])
  }, 120_000)

  it('nao perde a tentativa na revisao: reprova em vez de ficar em REVIEW', async () => {
    harness = await createHarness({
      mission: {
        requireReview: true,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      project: oneProvider(),
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: brokenHandleFactory('review', defaultStep),
    })
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).not.toBe('REVIEW')
    expect(task.status).not.toBe('DONE')
    expect(task.status).toBe('BLOCKED')

    const attempt = lastAttempt(await harness.attempts('T01'))
    expect(attempt.failureReason?.code).toBe('AGENT_ERROR')
    expect(attempt.review).toBeUndefined()
    expect(harness.orchestrator.inflightAttempts).toEqual([])
    expect(runningOf(harness)).toBe(0)
    expect(await harness.plane.persistence.runs.listLocks(harness.runId)).toEqual([])
  }, 120_000)
})

describe('recuperacao da task depois da morte do processo', () => {
  it('a segunda tentativa e despachada e conclui: nada fica preso da primeira', async () => {
    cli = await createFakeCli({
      'T01-a1': { kind: 'kill' },
      'T01-a2': { kind: 'ok' },
    })
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 2,
        tasks: [{ id: 'T01' }],
      },
      project: oneProvider(1),
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
    })
    await harness.orchestrator.drain()

    const attempts = await harness.attempts('T01')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.failureReason?.code).toBe('AGENT_ERROR')
    expect(attempts[1]?.failureReason).toBeUndefined()
    expect((await harness.task('T01')).status).toBe('DONE')
    // Cada tentativa tem worktree propria, e a da morte continua no disco para pericia.
    expect(existsSync(attempts[0]?.workspace.path ?? '')).toBe(true)
    expect(runningOf(harness)).toBe(0)
    expect(await harness.plane.persistence.runs.listLocks(harness.runId)).toEqual([])
  }, 120_000)
})
