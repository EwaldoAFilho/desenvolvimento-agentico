import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brokenHandleFactory, faultyLogFactory, type StepFn } from './__fixtures__/agents.js'
import { GATE_ALWAYS_PASS, GATE_FIRST_ATTEMPT_FAILS } from './__fixtures__/files.js'
import { createHarness, defaultStep, type Harness } from './__fixtures__/harness.js'
import { AGENT_LOG_FILE, AGENT_LOG_KIND, REVIEW_LOG_FILE, REVIEW_LOG_KIND } from './agent-log.js'

let harness: Harness | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.cleanup()
  harness = undefined
})

const writes = (taskId: string, attempt: number): Readonly<Record<string, string>> => ({
  [`packages/${taskId.toLowerCase()}/${taskId}.ts`]: `export const ${taskId} = ${attempt}\n`,
})

/** Roteiro que fala: o executor emite stdout/stderr e o revisor tambem. */
function talkative(stdout: readonly string[], stderr: readonly string[] = []): StepFn {
  return (context) =>
    context.kind === 'review'
      ? {
          status: 'completed',
          claims: { summary: 'VERDICT: PASS', detail: 'evidencia suficiente' },
          stdout: ['revisor: lendo o diff'],
          stderr: ['revisor: aviso de leitura'],
        }
      : {
          status: 'completed',
          claims: { summary: `${context.taskId} aplicada` },
          writeFiles: writes(context.taskId, context.attemptNumber),
          stdout: [...stdout],
          stderr: [...stderr],
        }
}

function logFile(current: Harness, taskId: string, attempt: number, file = AGENT_LOG_FILE): string {
  return join(
    current.root,
    '.agentic',
    'runs',
    current.runId,
    'attempts',
    `${taskId}-a${attempt}`,
    file,
  )
}

async function readLog(
  current: Harness,
  taskId: string,
  attempt: number,
  file = AGENT_LOG_FILE,
): Promise<Record<string, unknown>[]> {
  const raw = await readFile(logFile(current, taskId, attempt, file), 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('log do agente como artefato da tentativa', () => {
  it('grava agent.log.jsonl com o que o agente emitiu', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: talkative(['abrindo o repositorio', 'aplicando a mudanca']),
    })
    await harness.orchestrator.drain()

    expect((await harness.task('T01')).status).toBe('DONE')
    const linhas = await readLog(harness, 'T01', 1)
    expect(linhas.map((line) => line.chunk)).toEqual([
      'abrindo o repositorio',
      'aplicando a mudanca',
    ])
    expect(typeof linhas[0]?.ts).toBe('string')
  }, 120_000)

  /**
   * O defeito observado em uso real: tres tentativas com NO_CHANGES e nenhuma forma de
   * descobrir a causa, porque o diretorio da tentativa nao tinha log nenhum. Aqui o
   * desfecho continua sendo NO_CHANGES — o que muda e existir o que ler depois.
   */
  it('tentativa que falha com NO_CHANGES deixa o log de cada tentativa', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 2,
        tasks: [{ id: 'T01' }],
      },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: (context) => ({
        status: 'completed',
        claims: { summary: 'implementei tudo, 38 testes passaram' },
        stdout: [`tentativa ${context.attemptNumber}: nao achei o arquivo alvo`],
        stderr: [`tentativa ${context.attemptNumber}: permissao negada em packages/`],
      }),
    })
    await harness.orchestrator.drain()

    const attempts = await harness.attempts('T01')
    expect(attempts.every((attempt) => attempt.failureReason?.code === 'NO_CHANGES')).toBe(true)
    expect(attempts).toHaveLength(2)
    for (const numero of [1, 2]) {
      const linhas = await readLog(harness, 'T01', numero)
      expect(linhas.map((line) => line.chunk)).toEqual([
        `tentativa ${numero}: nao achei o arquivo alvo`,
        `tentativa ${numero}: permissao negada em packages/`,
      ])
    }
  }, 120_000)

  it('identifica stdout e stderr no artefato', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: talkative(['saida normal'], ['diagnostico no stderr']),
    })
    await harness.orchestrator.drain()

    const linhas = await readLog(harness, 'T01', 1)
    const porStream = new Map(linhas.map((line) => [line.stream, line.chunk]))
    expect(porStream.get('stdout')).toBe('saida normal')
    expect(porStream.get('stderr')).toBe('diagnostico no stderr')
  }, 120_000)

  it('CONTROLE: provider cujo logs() lanca NAO derruba a tentativa', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: faultyLogFactory('throws', defaultStep),
    })
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).toBe('DONE')
    expect(task.attemptCount).toBe(1)
    const attempts = await harness.attempts('T01')
    expect(attempts[0]?.result).toBe('PASS')
    expect(attempts[0]?.failureReason).toBeUndefined()

    // O problema nao some: fica escrito no proprio artefato.
    const linhas = await readLog(harness, 'T01', 1)
    expect(linhas.at(-1)?.event).toBe('log_incomplete')
    expect(String(linhas.at(-1)?.detail)).toContain('logs() indisponivel')
  }, 120_000)

  it('CONTROLE: stream de log que quebra no meio nao reprova a tentativa', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: faultyLogFactory('breaks', defaultStep),
    })
    await harness.orchestrator.drain()

    expect((await harness.task('T01')).status).toBe('DONE')
    const linhas = await readLog(harness, 'T01', 1)
    expect(linhas[0]?.chunk).toBe('linha observada antes da falha')
    expect(linhas.at(-1)?.event).toBe('log_incomplete')
  }, 120_000)

  it('CONTROLE: stream de log que nunca fecha nao trava a tentativa', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: faultyLogFactory('hangs', defaultStep),
      agentLog: { graceMs: 25 },
    })
    await harness.orchestrator.drain()

    expect((await harness.task('T01')).status).toBe('DONE')
    const linhas = await readLog(harness, 'T01', 1)
    expect(String(linhas.at(-1)?.detail)).toContain('nao terminou em 25ms')
  }, 120_000)

  it('trunca log acima do teto e marca a truncagem', async () => {
    const ruidoso = Array.from({ length: 200 }, (_, index) => `linha ${index} ${'x'.repeat(200)}`)
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: talkative(ruidoso),
      agentLog: { maxBytes: 2048 },
    })
    await harness.orchestrator.drain()

    expect((await harness.task('T01')).status).toBe('DONE')
    const raw = await readFile(logFile(harness, 'T01', 1), 'utf8')
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(2500)
    const linhas = raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const marcador = linhas.at(-1)
    expect(marcador?.event).toBe('truncated')
    expect(marcador?.limitBytes).toBe(2048)
    expect(Number(marcador?.droppedEvents)).toBeGreaterThan(0)
  }, 120_000)

  it('mascara segredo emitido pelo agente antes de gravar', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: talkative(['exportando API_KEY=nao-pode-vazar-1234'], ['token sk-abcdEFGH1234567890']),
    })
    await harness.orchestrator.drain()

    const raw = await readFile(logFile(harness, 'T01', 1), 'utf8')
    expect(raw).not.toContain('nao-pode-vazar-1234')
    expect(raw).not.toContain('sk-abcdEFGH1234567890')
    expect(raw).toContain('[REDACTED]')
  }, 120_000)

  it('registra o artefato com kind e caminho reais, e o arquivo existe la', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: talkative(['registro citavel']),
    })
    await harness.orchestrator.drain()

    const artifacts = harness.plane.persistence.artifacts.list(harness.runId)
    const log = artifacts.find((row) => row.kind === AGENT_LOG_KIND)
    expect(log?.path).toBe(`runs/${harness.runId}/attempts/T01-a1/${AGENT_LOG_FILE}`)
    expect(log?.bytes).toBeGreaterThan(0)

    // A referencia gravada aponta para um arquivo que existe de verdade.
    const absolute = join(harness.root, '.agentic', ...(log?.path ?? '').split('/'))
    expect(await readFile(absolute, 'utf8')).toContain('registro citavel')
  }, 120_000)

  it('revisor tem log proprio e nao sobrescreve o do executor', async () => {
    harness = await createHarness({
      mission: { requireReview: true, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: talkative(['executor falou aqui']),
    })
    await harness.orchestrator.drain()

    expect((await harness.task('T01')).status).toBe('DONE')
    const executor = await readLog(harness, 'T01', 1)
    const revisor = await readLog(harness, 'T01', 1, REVIEW_LOG_FILE)
    expect(executor.map((line) => line.chunk)).toContain('executor falou aqui')
    expect(revisor.map((line) => line.chunk)).toContain('revisor: lendo o diff')
    expect(revisor.map((line) => line.stream)).toContain('stderr')

    const kinds = harness.plane.persistence.artifacts
      .list(harness.runId)
      .map((row) => row.kind)
      .filter((kind) => kind === AGENT_LOG_KIND || kind === REVIEW_LOG_KIND)
    expect(kinds).toEqual([AGENT_LOG_KIND, REVIEW_LOG_KIND])
  }, 120_000)

  it('cada tentativa tem o seu proprio log, sem uma apagar a outra', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_FIRST_ATTEMPT_FAILS] },
      step: (context) =>
        context.kind === 'review'
          ? { status: 'completed', claims: { summary: 'VERDICT: PASS' } }
          : {
              status: 'completed',
              claims: { summary: `T01 tentativa ${context.attemptNumber}` },
              writeFiles: writes(context.taskId, context.attemptNumber),
              stdout: [`tentativa ${context.attemptNumber} falando`],
            },
    })
    await harness.orchestrator.drain()

    expect((await harness.task('T01')).attemptCount).toBe(2)
    expect((await readLog(harness, 'T01', 1)).map((line) => line.chunk)).toEqual([
      'tentativa 1 falando',
    ])
    expect((await readLog(harness, 'T01', 2)).map((line) => line.chunk)).toEqual([
      'tentativa 2 falando',
    ])
  }, 120_000)

  it('tentativa que morre sem desfecho ainda deixa o artefato de log', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 1,
        tasks: [{ id: 'T01' }],
      },
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: brokenHandleFactory('execute'),
    })
    await harness.orchestrator.drain()

    const attempts = await harness.attempts('T01')
    expect(attempts[0]?.failureReason?.code).toBe('AGENT_ERROR')
    // Arquivo presente mesmo vazio: prova de que olhamos, e nao de que houve saida.
    await expect(readFile(logFile(harness, 'T01', 1), 'utf8')).resolves.toBe('')
  }, 120_000)

  it('CONTROLE: falha ao GRAVAR o artefato de log nao derruba a tentativa', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: talkative(['nao vai conseguir ser gravado']),
    })
    const store = harness.plane.persistence.artifacts
    const original = store.write.bind(store)
    vi.spyOn(store, 'write').mockImplementation(async (input) => {
      if (input.kind === AGENT_LOG_KIND) throw new Error('disco cheio ao gravar o log')
      return original(input)
    })

    await harness.orchestrator.drain()

    // Gravacao do log e observabilidade: falhar ali nao muda o desfecho da tentativa.
    const task = await harness.task('T01')
    expect(task.status).toBe('DONE')
    const attempts = await harness.attempts('T01')
    expect(attempts[0]?.result).toBe('PASS')
    expect(attempts[0]?.failureReason).toBeUndefined()
    // E nao some em catch mudo: fica visivel para quem inspeciona o run.
    expect(harness.orchestrator.errors.map((error) => String((error as Error).message))).toContain(
      'disco cheio ao gravar o log',
    )
  }, 120_000)

  it('nao inventa log quando o agente nao emite nada', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: defaultStep,
    })
    await harness.orchestrator.drain()

    expect((await harness.task('T01')).status).toBe('DONE')
    await expect(readFile(logFile(harness, 'T01', 1), 'utf8')).resolves.toBe('')
  }, 120_000)
})

/**
 * Achado da revisao independente de T209b: o log virava artefato, mas a linha do tempo nao
 * dizia isso — o operador so encontrava o arquivo se pensasse em procurar. O evento fecha
 * o vinculo entre "aconteceu" e "ha diagnostico disponivel".
 */
describe('attempt.log_persisted', () => {
  it('anuncia na linha do tempo que existe log, com caminho e tamanho', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
      step: talkative(['abrindo o repositorio']),
    })
    await harness.orchestrator.drain()

    const eventos = (await harness.events()).filter(
      (event) => event.type === 'attempt.log_persisted',
    )
    expect(eventos.length).toBeGreaterThan(0)

    const payload = eventos[0]?.payload as {
      role: string
      path: string
      bytes: number
      truncated: boolean
    }
    expect(payload.role).toBe('execute')
    expect(payload.path).toContain('agent')
    expect(payload.bytes).toBeGreaterThan(0)
    expect(payload.truncated).toBe(false)
    expect(eventos[0]?.taskId).toBe('T01')
    expect(eventos[0]?.attemptId).toBeDefined()
  }, 120_000)
})
