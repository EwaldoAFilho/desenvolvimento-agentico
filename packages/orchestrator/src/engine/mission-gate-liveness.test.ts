import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GATE_ALWAYS_PASS } from './__fixtures__/files.js'

/** Imprime o COMMIT que o gate esta julgando — o que importa quando HEAD e detached. */
const MISSION_GATE_PRINT_HEAD = 'git rev-parse HEAD'

import { createHarness, type Harness } from './__fixtures__/harness.js'

/**
 * STABILITY-SLICE-001. Duas provas independentes sobre o mission gate.
 *
 * D1 (liveness, I12): a aquisicao da worktree da missao pode falhar. Antes desta fatia o
 * erro subia de um `try/finally` SEM `catch`, morria no array em memoria `#errors` e
 * NENHUMA mensagem voltava ao loop; com `#missionGateStarted` ja travado em `true`, nenhum
 * tick tentava de novo e o run ficava em VERIFYING para sempre — afirmando que verificava
 * sem nada verificando.
 *
 * D2 (workspace): no dogfooding a arvore principal esta na PROPRIA branch da missao, e
 * `git worktree add <path> <branch>` falha com exit 128. O gate julga um COMMIT, entao a
 * aquisicao cai para detach sobre o mesmo sha em vez de disputar o ref.
 */

describe('D1 — run em VERIFYING nunca fica sem desfecho (I12)', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({
      mission: { missionGate: 'mission', tasks: [{ id: 'T01' }] },
      // O comando nao importa: este gate nunca chega a ser executado.
      gates: { unit: [GATE_ALWAYS_PASS], mission: [GATE_ALWAYS_PASS] },
    })
    // Falha real de aquisicao, pelo caminho do proprio provider: o destino ja existe e
    // `#assertFreePath` recusa. Nao e o exit 128 do git que originou o defeito — esse
    // caminho D2 agora resolve — mas e uma excecao verdadeira de `acquireMission`, que e
    // exatamente o que D1 precisa transformar em estado.
    await mkdir(join(harness.root, '.agentic', 'worktrees', harness.runId, 'mission'), {
      recursive: true,
    })
    await harness.orchestrator.drain()
  }, 180_000)

  afterAll(async () => {
    await harness?.cleanup()
  })

  it('nao deixa o run parado em VERIFYING depois que o loop estabiliza', async () => {
    const run = await harness.run()
    expect(run.status).not.toBe('VERIFYING')
    expect(run.status).toBe('FAILED')
  })

  it('grava no event log a razao pela qual o mission gate nao produziu resultado', async () => {
    const types = await harness.eventTypes()
    expect(types).toContain('gate.finished')
    expect(types).toContain('run.failed')
  })

  it('converte a falha em estado, em vez de engoli-la num array so de memoria', () => {
    expect(harness.orchestrator.errors).toEqual([])
  })

  it('preserva o detalhe observavel da falha, nao so o status ERROR', async () => {
    const events = await harness.events()
    const failed = events.find((event) => event.type === 'run.failed')
    const reason = (failed?.payload as { readonly reason?: string } | undefined)?.reason ?? ''
    expect(reason).toContain('mission gate esta ERROR')
    expect(reason).toContain('caminho de worktree ja existe')
    const run = await harness.run()
    expect(run.failureReason).toBe(reason)
  })

  it('nao inventa execucao de gate que nao houve', async () => {
    const run = await harness.run()
    expect(run.missionGateExecutionId).toBeUndefined()
  })
})

describe('D2 — branch da missao ja em check-out na arvore principal', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({
      mission: { missionGate: 'mission', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS], mission: [MISSION_GATE_PRINT_HEAD] },
    })
    await harness.git('checkout', '-q', 'mission/DA-TEST-001')
    await harness.orchestrator.drain()
  }, 180_000)

  afterAll(async () => {
    await harness?.cleanup()
  })

  it('o mission gate efetivamente inicia e termina', async () => {
    const events = await harness.events()
    const started = events.filter(
      (event) =>
        event.type === 'gate.started' &&
        (event.payload as { readonly scope?: string }).scope === 'mission',
    )
    expect(started).toHaveLength(1)
    const finished = events.filter(
      (event) => event.type === 'gate.finished' && event.taskId === undefined,
    )
    expect(finished).toHaveLength(1)
  })

  it('conclui o run com o gate registrado', async () => {
    const run = await harness.run()
    expect(run.status).toBe('COMPLETED')
    expect(run.missionGateExecutionId).toBeTypeOf('string')
    expect(harness.orchestrator.errors).toEqual([])
  })

  it('roda numa worktree propria, sobre o sha exato da branch da missao', async () => {
    const raw = await harness.plane.persistence.artifacts.readText(
      harness.runId,
      'mission/gate.json',
    )
    const execution = JSON.parse(raw) as {
      status: string
      results: { cwd: string; stdoutRef?: string }[]
    }
    expect(execution.status).toBe('PASS')
    expect(execution.results[0]?.cwd ?? '').toMatch(/\/mission$/)
    expect(execution.results[0]?.cwd ?? '').not.toContain('-a1')
    // Detached nao basta: o gate tem de ter julgado o MESMO commit da branch da missao.
    const stdout = await harness.plane.persistence.artifacts.readText(
      harness.runId,
      execution.results[0]?.stdoutRef ?? '',
    )
    const missionSha = await harness.git('rev-parse', 'mission/DA-TEST-001')
    expect(stdout.trim()).toBe(missionSha)
  })

  it('nao rouba a branch de quem ja a segurava', async () => {
    const head = await harness.git('rev-parse', '--abbrev-ref', 'HEAD')
    expect(head).toBe('mission/DA-TEST-001')
  })
})

/**
 * D1, o caso mais traicoeiro: o gate RODA e produz resultado, mas a transacao que o
 * persiste falha. Antes, `#missionGateStarted` continuava `true` e `#missionGate` ficava
 * indefinido — nenhum tick tentaria de novo e o run ficaria em VERIFYING para sempre.
 * A trava tem de cair junto com a escrita reprovada.
 */
describe('D1 — escrita do desfecho do gate reprovada nao trava o run', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({
      mission: { missionGate: 'mission', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS], mission: [GATE_ALWAYS_PASS] },
    })
    const runs = harness.plane.persistence.runs
    const original = runs.withTransaction.bind(runs)
    let alreadyFailed = false
    vi.spyOn(runs, 'withTransaction').mockImplementation((work) =>
      original(async (uow) => {
        const proxy = new Proxy(uow, {
          get(target, prop) {
            // O unit of work usa campos privados: os metodos precisam continuar ligados
            // ao alvo, nunca ao proxy.
            const bind = (value: unknown): unknown =>
              typeof value === 'function'
                ? (value as (...args: unknown[]) => unknown).bind(target)
                : value
            // Falha UMA vez, exatamente na transacao que grava a GateExecution da MISSAO
            // (o gate de task tambem passa por aqui e nao pode ser afetado).
            if (prop === 'saveGateExecution') {
              const save = bind(Reflect.get(target, prop, target)) as (execution: {
                readonly scope: string
              }) => Promise<void>
              return (execution: { readonly scope: string }) => {
                if (execution.scope === 'mission' && !alreadyFailed) {
                  alreadyFailed = true
                  throw new Error('falha transitoria de escrita')
                }
                return save(execution)
              }
            }
            return bind(Reflect.get(target, prop, target))
          },
        })
        return work(proxy as typeof uow)
      }),
    )
    await harness.orchestrator.drain()
  }, 180_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await harness?.cleanup()
  })

  it('solta a trava e reexecuta o gate em vez de ficar em VERIFYING', async () => {
    const run = await harness.run()
    expect(run.status).not.toBe('VERIFYING')
    expect(run.status).toBe('COMPLETED')
    expect(run.missionGateExecutionId).toBeTypeOf('string')
  })

  it('a falha transitoria fica visivel, nao e varrida para debaixo do tapete', () => {
    expect(harness.orchestrator.errors).toHaveLength(1)
  })
})
