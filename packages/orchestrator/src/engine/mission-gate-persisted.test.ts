import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GATE_ALWAYS_PASS } from './__fixtures__/files.js'
import { createHarness, type Harness } from './__fixtures__/harness.js'

/**
 * D12 — resultado de mission gate PERSISTIDO e usado depois de um reinicio, nao refeito.
 *
 * I12 tem duas metades: run em VERIFYING tem gate em voo OU resultado persistido. A primeira
 * metade sempre foi coberta pela adocao (o gate reinicia do zero). A segunda nao era: o
 * cache do resultado vivia so em memoria, entao um control plane que caisse ENTRE gravar
 * a GateExecution e concluir o run refazia o gate no proximo dono — segunda execucao,
 * `missionGateExecutionId` sobrescrito, uma medicao a mais que ninguem pediu.
 *
 * A janela e estreita (duas transacoes consecutivas do mesmo tick) e passou a ser comum: o
 * encerramento gracioso COLHE o resultado do mission gate antes de devolver o projeto, e o
 * proximo dono precisa encontra-lo em vez de refaze-lo.
 */

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

let primeiro: Harness
let segundo: Harness
let execucaoPersistida: string | undefined
let errosDoPrimeiro: number

beforeAll(async () => {
  primeiro = await createHarness({
    mission: { missionGate: 'mission', tasks: [{ id: 'T01' }], defaultGate: 'unit' },
    gates: { unit: [GATE_ALWAYS_PASS], mission: [GATE_ALWAYS_PASS] },
    safetyIntervalMs: 0,
  })
  // Falha UMA vez, exatamente na transacao que conclui o run — a GateExecution ja esta no
  // banco nesse instante. E o retrato de uma queda entre as duas escritas.
  const runs = primeiro.plane.persistence.runs
  const original = runs.withTransaction.bind(runs)
  let jaFalhou = false
  vi.spyOn(runs, 'withTransaction').mockImplementation((work) =>
    original(async (uow) => {
      const proxy = new Proxy(uow, {
        get(target, prop) {
          const bind = (value: unknown): unknown =>
            typeof value === 'function'
              ? (value as (...args: unknown[]) => unknown).bind(target)
              : value
          if (prop === 'saveRun') {
            const save = bind(Reflect.get(target, prop, target)) as (run: {
              readonly status: string
            }) => Promise<void>
            return (run: { readonly status: string }) => {
              if (run.status === 'COMPLETED' && !jaFalhou) {
                jaFalhou = true
                throw new Error('queda entre gravar o gate e concluir o run')
              }
              return save(run)
            }
          }
          return bind(Reflect.get(target, prop, target))
        },
      })
      return work(proxy as typeof uow)
    }),
  )
  // Dirige o loop tick a tick ate o resultado do gate estar no banco com o run ainda em
  // VERIFYING — sem `drain`, que seguiria adiante e concluiria o run no tick seguinte.
  const limite = Date.now() + 60_000
  for (;;) {
    await primeiro.orchestrator.tick()
    const run = await primeiro.run()
    if (run.status === 'VERIFYING' && run.missionGateExecutionId !== undefined) break
    if (Date.now() > limite) throw new Error(`nao cheguei ao estado esperado: ${run.status}`)
    await delay(25)
  }
  execucaoPersistida = (await primeiro.run()).missionGateExecutionId
  errosDoPrimeiro = primeiro.orchestrator.errors.length
  vi.restoreAllMocks()

  // Queda do control plane: o proximo dono nasce com o cache vazio.
  segundo = await primeiro.reopen()
  await segundo.orchestrator.drain()
}, 180_000)

afterAll(async () => {
  await segundo?.cleanup()
})

describe('D12 — mission gate persistido sobrevive ao reinicio', () => {
  it('o primeiro dono gravou a execucao e caiu antes de concluir o run', () => {
    expect(execucaoPersistida).toBeTypeOf('string')
    expect(errosDoPrimeiro).toBe(1)
  })

  it('o segundo dono conclui o run com a MESMA execucao, sem refazer o gate', async () => {
    const run = await segundo.run()
    expect(run.status).toBe('COMPLETED')
    expect(run.missionGateExecutionId).toBe(execucaoPersistida)
  })

  it('ha exatamente UMA execucao de mission gate no log', async () => {
    const events = await segundo.events()
    const iniciados = events.filter(
      (event) => event.type === 'gate.started' && event.payload.scope === 'mission',
    )
    expect(iniciados).toHaveLength(1)
  })
})
