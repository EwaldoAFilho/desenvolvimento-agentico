import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { taskId as toTaskId } from '@agentic/domain'
import { acquireControlPlaneOwnership } from '@agentic/persistence'
import type { GroupProbeDeps, RuntimeDeps } from '@agentic/process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeCli, type FakeCli } from './__fixtures__/fake-cli.js'
import { GATE_ALWAYS_PASS } from './__fixtures__/files.js'
import { createHarness, DEFAULT_ACTOR, type Harness } from './__fixtures__/harness.js'
import { ShutdownTimeoutError } from './errors.js'
import type { GateExecutor } from './types.js'

/**
 * STABILITY-SLICE-004B — contrato de cancelamento e assentamento do grupo de processos, do
 * ponto de vista de quem GOVERNA o ciclo de vida: o orquestrador e o plane.
 *
 * Quatro propriedades, cada uma medida sobre codigo de producao com processos de verdade
 * (executavel falso, gate real, `workspaceSetup` real) e uma sonda de grupo injetada — o
 * unico jeito portavel de fabricar um grupo que "sobrevive" a SIGKILL:
 *
 * - C2: cancelamento humano nao declara CANCELLED enquanto a morte do grupo nao for provada;
 *   intencao de cancelar e cancelamento assentado sao coisas diferentes.
 * - C3: o residuo (gate, setup, tentativa) SOBREVIVE entre tentativas de `close`, sondado de
 *   novo a cada uma; a posse so sai quando a sonda prova a morte.
 * - B1-final: o lider que sai SOZINHO deixando descendente vivo nao produz resultado
 *   assentado — o orquestrador recebe `groupTerminated=false`, nao mede a worktree, guarda o
 *   residuo e o encerramento nao libera a posse ate a confirmacao.
 * - controle: com o grupo morto (sonda real), tudo assenta como antes.
 */

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

async function esperar(label: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const limite = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > limite) throw new Error(`esperei ${label} por ${timeoutMs}ms`)
    await delay(20)
  }
}

function vivo(pid: number): boolean {
  try {
    nodeProcess.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function matarArvore(pid: number): void {
  for (const alvo of [-pid, pid]) {
    try {
      nodeProcess.kill(alvo, 'SIGKILL')
    } catch {
      /* ja morreu */
    }
  }
}

/**
 * Grupo "imortal" controlado pelo teste. A MESMA sonda alimenta o runtime do executavel
 * falso, o gate runner, o `workspaceSetup` e a re-sonda do orquestrador: `mata()` e a prova
 * de morte chegando para todos.
 */
function grupo(): {
  readonly runtime: RuntimeDeps
  readonly probe: GroupProbeDeps
  mata(): void
  sondas(): number
} {
  let vivoAgora = true
  let sondas = 0
  const probeGroup = (): boolean => {
    sondas += 1
    return vivoAgora
  }
  return {
    runtime: { killGraceMs: 200, groupGraceMs: 100, closeGraceMs: 300, probeGroup },
    probe: { groupGraceMs: 100, probeGroup },
    mata: () => {
      vivoAgora = false
    },
    sondas: () => sondas,
  }
}

const HUMANO = { actor: DEFAULT_ACTOR }
const MISSION = { tasks: [{ id: 'T01' }], defaultGate: 'unit', requireReview: false }
const GATES = { unit: [GATE_ALWAYS_PASS] }
const T01 = toTaskId('T01')

/** `close` com prazo curto: os tetos injetados sao de centenas de ms. */
const fecha = (h: Harness): Promise<unknown> =>
  h.plane.close({ graceMs: 8_000 }).then(
    () => undefined,
    (error: unknown) => error,
  )

const codigoDe = (error: unknown): string | undefined =>
  (error as { readonly code?: unknown } | undefined)?.code as string | undefined

let h: Harness | undefined
let cli: FakeCli | undefined
let tmp: string | undefined
let pidFile: string | undefined

afterEach(async () => {
  if (pidFile !== undefined && existsSync(pidFile))
    matarArvore(Number(readFileSync(pidFile, 'utf8')))
  pidFile = undefined
  await h?.cleanup().catch(() => undefined)
  h = undefined
  await cli?.cleanup()
  cli = undefined
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true })
  tmp = undefined
})

async function agenteQueTrava(g: ReturnType<typeof grupo> | undefined): Promise<number> {
  tmp = await mkdtemp(join(tmpdir(), 'agentic-cancel-'))
  pidFile = join(tmp, 'pid')
  cli = await createFakeCli(
    { default: { kind: 'hang', pidFile } },
    g === undefined ? {} : { processDeps: g.runtime },
  )
  h = await createHarness({
    mission: MISSION,
    gates: GATES,
    factory: cli.factory,
    safetyIntervalMs: 0,
    ...(g === undefined ? {} : { processProbe: g.probe }),
  })
  await h.orchestrator.tick()
  const arquivo = pidFile
  await esperar('pid do agente', () => existsSync(arquivo))
  return Number(readFileSync(arquivo, 'utf8'))
}

describe('C2 — cancelamento humano com grupo de processos vivo', () => {
  it('cancel do run: o comando e RECUSADO (CANCELLATION_UNSETTLED), nada vira CANCELLED, e o mesmo comando assenta depois da prova de morte', async () => {
    const g = grupo()
    const pid = await agenteQueTrava(g)
    const harness = h as Harness

    const erro = await harness.plane
      .stopRun(harness.runId, { ...HUMANO, reason: 'operador parou' })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      )
    expect(codigoDe(erro)).toBe('CANCELLATION_UNSETTLED')
    // O SIGTERM chegou: o lider morreu. Mas o GRUPO nao esta provado morto — e o estado
    // oficial nao pode afirmar o que ninguem mediu.
    await esperar('lider morrer', () => !vivo(pid), 5_000)
    expect((await harness.run()).status).toBe('RUNNING')
    expect((await harness.task('T01')).status).toBe('RUNNING')
    const [tentativa] = await harness.attempts('T01')
    expect(tentativa?.finishedAt).toBeUndefined()
    expect(tentativa?.result).toBeUndefined()
    const tipos = await harness.eventTypes()
    expect(tipos).not.toContain('run.cancelled')
    expect(tipos).not.toContain('task.cancelled')
    expect(tipos).not.toContain('attempt.cancelled')

    g.mata()
    await harness.plane.stopRun(harness.runId, { ...HUMANO, reason: 'operador parou' })
    expect((await harness.run()).status).toBe('CANCELLED')
    expect((await harness.task('T01')).status).toBe('CANCELLED')
    const [fechada] = await harness.attempts('T01')
    expect(fechada?.result).toBe('CANCELLED')
    await harness.plane.close()
    expect(harness.plane.lifecycle).toBe('closed')
  }, 60_000)

  it('cancel do run recusado + close: a posse fica retida ate a morte confirmada, e o proximo dono encontra a tentativa RUNNING', async () => {
    const g = grupo()
    await agenteQueTrava(g)
    const harness = h as Harness

    await expect(
      harness.plane.stopRun(harness.runId, { ...HUMANO, reason: 'parar' }),
    ).rejects.toMatchObject({ code: 'CANCELLATION_UNSETTLED' })
    const primeiro = await fecha(harness)
    expect(primeiro).toBeInstanceOf(ShutdownTimeoutError)
    expect((primeiro as ShutdownTimeoutError).residualProcesses.join(' ')).toMatch(/tentativa/)
    expect(harness.lease.held).toBe(true)
    expect(harness.plane.lifecycle).toBe('closing')
    const outro = acquireControlPlaneOwnership({ baseDir: join(harness.root, '.agentic') })
    expect(outro.ok).toBe(false)

    // Nada foi presumido: a tentativa continua RUNNING no banco — e e assim que o proximo dono
    // a encontra, para reconciliar como INTERRUPTED.
    expect((await harness.task('T01')).status).toBe('RUNNING')
    g.mata()
    await harness.plane.close({ graceMs: 8_000 })
    expect(harness.plane.lifecycle).toBe('closed')
  }, 60_000)

  it('cancel de UMA task: recusado com o grupo vivo, a intencao e mantida (nenhum redespacho) e assenta depois da prova', async () => {
    const g = grupo()
    const pid = await agenteQueTrava(g)
    const harness = h as Harness

    await expect(
      harness.plane.cancelTask(harness.runId, { ...HUMANO, taskId: T01, reason: 'so esta' }),
    ).rejects.toMatchObject({ code: 'CANCELLATION_UNSETTLED' })
    await esperar('lider morrer', () => !vivo(pid), 5_000)
    expect((await harness.task('T01')).status).toBe('RUNNING')

    // O desfecho do agente chega ao loop; com a intencao de cancelar pendente e o grupo
    // ainda vivo, o loop NAO reprova/redespacha a task por conta propria.
    await delay(800)
    await harness.orchestrator.tick()
    await harness.orchestrator.tick()
    const task = await harness.task('T01')
    expect({ status: task.status, tentativas: (await harness.attempts('T01')).length }).toEqual({
      status: 'RUNNING',
      tentativas: 1,
    })
    expect(harness.orchestrator.inflightAttempts).toHaveLength(1)

    g.mata()
    await harness.plane.cancelTask(harness.runId, { ...HUMANO, taskId: T01, reason: 'so esta' })
    expect((await harness.task('T01')).status).toBe('CANCELLED')
    const [fechada] = await harness.attempts('T01')
    expect(fechada?.result).toBe('CANCELLED')
    expect(harness.orchestrator.inflightAttempts).toHaveLength(0)
    await harness.plane.close({ graceMs: 8_000 })
    expect(harness.plane.lifecycle).toBe('closed')
  }, 60_000)

  it('controle: cancel do run com o grupo morto (sonda real) assenta na primeira chamada', async () => {
    const pid = await agenteQueTrava(undefined)
    const harness = h as Harness
    await harness.plane.stopRun(harness.runId, { ...HUMANO, reason: 'operador parou' })
    expect((await harness.run()).status).toBe('CANCELLED')
    expect((await harness.task('T01')).status).toBe('CANCELLED')
    await esperar('lider morrer', () => !vivo(pid), 5_000)
    await harness.plane.close()
    expect(harness.plane.lifecycle).toBe('closed')
  }, 60_000)
})

describe('C3 — o residuo sobrevive entre tentativas de stop', () => {
  it('gate: stop #1 e stop #2 recusam com o mesmo residuo; provada a morte, stop #3 libera', async () => {
    const g = grupo()
    h = await createHarness({
      mission: MISSION,
      gates: GATES,
      safetyIntervalMs: 0,
      processProbe: g.probe,
    })
    const harness = h
    await harness.orchestrator.drain()
    // A medicao valeu (exit 0): a task concluiu. O residuo e assunto do encerramento.
    expect((await harness.task('T01')).status).toBe('DONE')

    const primeiro = await fecha(harness)
    expect(primeiro).toBeInstanceOf(ShutdownTimeoutError)
    expect((primeiro as ShutdownTimeoutError).residualProcesses.join(' ')).toMatch(/gate/)
    expect(harness.lease.held).toBe(true)

    const sondasAntes = g.sondas()
    const segundo = await fecha(harness)
    // "Nao lembro mais" nao existe: o segundo stop sondou o MESMO residuo de novo e recusou.
    expect(segundo).toBeInstanceOf(ShutdownTimeoutError)
    expect((segundo as ShutdownTimeoutError).residualProcesses.join(' ')).toMatch(/gate/)
    expect(g.sondas()).toBeGreaterThan(sondasAntes)
    expect(harness.lease.held).toBe(true)
    expect(acquireControlPlaneOwnership({ baseDir: join(harness.root, '.agentic') }).ok).toBe(false)

    g.mata()
    await harness.plane.close({ graceMs: 8_000 })
    expect(harness.plane.lifecycle).toBe('closed')
  }, 60_000)

  it('workspaceSetup: o residuo do setup tambem sobrevive a duas recusas e so libera com a prova', async () => {
    const g = grupo()
    h = await createHarness({
      mission: MISSION,
      gates: GATES,
      project: { workspaceSetup: ["node -e 'process.exit(0)'"] },
      safetyIntervalMs: 0,
      processProbe: g.probe,
    })
    const harness = h
    await harness.orchestrator.tick()
    // Sem prova de que o setup parou, a worktree nao e entregue: a task continua READY.
    expect((await harness.task('T01')).status).toBe('READY')

    const primeiro = await fecha(harness)
    expect(primeiro).toBeInstanceOf(ShutdownTimeoutError)
    expect((primeiro as ShutdownTimeoutError).residualProcesses.join(' ')).toMatch(/workspaceSetup/)

    const segundo = await fecha(harness)
    expect(segundo).toBeInstanceOf(ShutdownTimeoutError)
    expect((segundo as ShutdownTimeoutError).residualProcesses.join(' ')).toMatch(/workspaceSetup/)
    expect(harness.lease.held).toBe(true)

    g.mata()
    await harness.plane.close({ graceMs: 8_000 })
    expect(harness.plane.lifecycle).toBe('closed')
  }, 60_000)
})

describe('revisao ciclo 1 — intencao sem tentativa em voo; residuo de gate sem pid', () => {
  it('cancel task com residuo de setup e SEM tentativa em voo: recusado, nenhum redespacho, e cumprido sozinho quando a prova chega', async () => {
    const g = grupo()
    h = await createHarness({
      mission: MISSION,
      gates: GATES,
      project: { workspaceSetup: ["node -e 'process.exit(0)'"] },
      safetyIntervalMs: 0,
      processProbe: g.probe,
    })
    const harness = h
    await harness.orchestrator.tick()
    expect((await harness.task('T01')).status).toBe('READY')
    expect(harness.orchestrator.inflightAttempts).toHaveLength(0)

    await expect(
      harness.plane.cancelTask(harness.runId, { ...HUMANO, taskId: T01, reason: 'desisti' }),
    ).rejects.toMatchObject({ code: 'CANCELLATION_UNSETTLED' })
    expect((await harness.task('T01')).status).toBe('READY')

    // Passado o cooldown do workspace, o scheduler voltaria a despachar a task (e o setup
    // reprovaria de novo, gravando outro GUARD_FAILED): a intencao de cancelar tem de segurar
    // o despacho mesmo sem tentativa em voo.
    const guardas = async (): Promise<number> =>
      (await harness.eventTypes()).filter((type) => type === 'policy.invalid_transition').length
    const antes = await guardas()
    await delay(2_300)
    await harness.orchestrator.tick()
    await harness.orchestrator.tick()
    expect((await harness.task('T01')).status).toBe('READY')
    expect(await guardas()).toBe(antes)
    expect(await harness.attempts('T01')).toHaveLength(0)
    expect(harness.orchestrator.inflightAttempts).toHaveLength(0)

    // A prova chega: o proximo tick cumpre o cancelamento pedido, sem novo comando humano.
    g.mata()
    await harness.orchestrator.tick()
    expect((await harness.task('T01')).status).toBe('CANCELLED')
    expect(await harness.eventTypes()).toContain('task.cancelled')
    await harness.plane.close({ graceMs: 8_000 })
    expect(harness.plane.lifecycle).toBe('closed')
  }, 60_000)

  it('gate que relata grupo vivo SEM pid: residuo nao sondavel falha fechado — close recusa, e continua recusando', async () => {
    const semPid: GateExecutor = {
      run: (request) =>
        Promise.resolve({
          id: 'gate_sem_pid',
          gateId: request.gate.id,
          scope: request.scope,
          runId: request.runId,
          attemptId: request.attemptId,
          startedAt: new Date(),
          finishedAt: new Date(),
          status: 'PASS',
          results: [
            {
              index: 0,
              command: 'fake',
              cwd: request.cwd,
              required: true,
              argv: ['fake'],
              exitCode: 0,
              signal: null,
              timedOut: false,
              groupTerminated: false,
              pid: null,
              durationMs: 1,
              startedAt: new Date(),
              finishedAt: new Date(),
              truncated: false,
              stdout: { text: '', truncated: false, digest: 'd', artifactDigest: 'd' },
              stderr: { text: '', truncated: false, digest: 'd', artifactDigest: 'd' },
            },
          ],
          skipped: [],
          residualProcess: true,
          cwd: request.cwd,
          envAllow: [],
        }),
    }
    h = await createHarness({
      mission: MISSION,
      gates: GATES,
      safetyIntervalMs: 0,
      gateRunner: semPid,
    })
    const harness = h
    await harness.orchestrator.drain()
    expect((await harness.task('T01')).status).toBe('DONE')

    const primeiro = await fecha(harness)
    expect(primeiro).toBeInstanceOf(ShutdownTimeoutError)
    expect((primeiro as ShutdownTimeoutError).residualProcesses.join(' ')).toMatch(/gate .*sem pid/)
    const segundo = await fecha(harness)
    expect(segundo).toBeInstanceOf(ShutdownTimeoutError)
    expect(harness.lease.held).toBe(true)
  }, 60_000)
})

describe('revisao ciclo 2 — cada residuo tem identidade propria', () => {
  it('mission gate executado duas vezes deixa DOIS residuos de setup (A e B): B morre, A continua, e a posse fica por A', async () => {
    // Sonda por pgid, na ordem em que os grupos aparecem: o 1o (setup da task) e o 2o (gate
    // da task) morrem; do 3o em diante — os setups do mission gate, A e depois B — ficam
    // vivos ate o teste mata-los, um de cada vez.
    const vistos: number[] = []
    const mortos = new Set<number>()
    const probeGroup = (pgid: number): boolean => {
      const pid = -pgid
      if (!vistos.includes(pid)) vistos.push(pid)
      return vistos.indexOf(pid) >= 2 && !mortos.has(pid)
    }
    h = await createHarness({
      mission: { ...MISSION, missionGate: 'unit' },
      gates: GATES,
      project: { workspaceSetup: ["node -e 'process.exit(0)'"] },
      safetyIntervalMs: 0,
      processProbe: { groupGraceMs: 100, probeGroup },
    })
    const harness = h
    // A escrita do desfecho do mission gate (setup reprovado -> `gate.finished` ERROR) falha
    // UMA vez: a trava do gate cai e o tick seguinte executa o gate — e o setup — de novo.
    const runs = harness.plane.persistence.runs
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
            if (prop === 'appendEvent') {
              const append = bind(Reflect.get(target, prop, target)) as (event: {
                readonly type: string
                readonly payload: { readonly status?: string }
              }) => Promise<void>
              return (event: {
                readonly type: string
                readonly payload: { readonly status?: string }
              }) => {
                if (
                  event.type === 'gate.finished' &&
                  event.payload.status === 'ERROR' &&
                  !jaFalhou
                ) {
                  jaFalhou = true
                  throw new Error('queda ao gravar o desfecho do mission gate')
                }
                return append(event)
              }
            }
            return bind(Reflect.get(target, prop, target))
          },
        })
        return work(proxy as typeof uow)
      }),
    )
    try {
      await harness.orchestrator.drain()
    } finally {
      vi.restoreAllMocks()
    }
    expect(jaFalhou).toBe(true)
    expect((await harness.run()).status).toBe('FAILED')
    const [, , a, b] = vistos
    expect(typeof a).toBe('number')
    expect(typeof b).toBe('number')
    expect(a).not.toBe(b)

    // B morre; A continua vivo. O encerramento tem de recusar POR A — que so existe se cada
    // residuo tiver identidade propria em vez de uma chave fixa que o segundo sobrescreve.
    mortos.add(b as number)
    const primeiro = await fecha(harness)
    expect(primeiro).toBeInstanceOf(ShutdownTimeoutError)
    const residuos = (primeiro as ShutdownTimeoutError).residualProcesses.join(' ')
    expect(residuos).toContain(`pgid ${a}`)
    expect(residuos).not.toContain(`pgid ${b}`)

    mortos.add(a as number)
    await harness.plane.close({ graceMs: 8_000 })
    expect(harness.plane.lifecycle).toBe('closed')
  }, 90_000)
})

describe('B1-final — saida natural do agente com descendente vivo', () => {
  it('exit 0 + grupo vivo: a tentativa NAO assenta (nao vira DONE, a worktree nao e medida), o residuo fica com o orquestrador e a posse so sai com a prova', async () => {
    const g = grupo()
    cli = await createFakeCli({ default: { kind: 'ok' } }, { processDeps: g.runtime })
    h = await createHarness({
      mission: { ...MISSION, maxAttempts: 1 },
      gates: GATES,
      factory: cli.factory,
      safetyIntervalMs: 0,
      processProbe: g.probe,
    })
    const harness = h
    await harness.orchestrator.drain()

    const task = await harness.task('T01')
    expect(task.status).not.toBe('DONE')
    const [tentativa] = await harness.attempts('T01')
    expect(tentativa?.result).toBe('ERROR')
    expect(tentativa?.failureReason?.detail ?? '').toMatch(/grupo/)
    // Um workspace que um descendente ainda muta nao e evidencia: nada foi medido nem commitado.
    expect(tentativa?.observation).toBeUndefined()
    expect(await harness.eventTypes()).not.toContain('attempt.observed')

    const primeiro = await fecha(harness)
    expect(primeiro).toBeInstanceOf(ShutdownTimeoutError)
    expect((primeiro as ShutdownTimeoutError).residualProcesses.join(' ')).toMatch(/tentativa/)
    expect(harness.lease.held).toBe(true)

    g.mata()
    await harness.plane.close({ graceMs: 8_000 })
    expect(harness.plane.lifecycle).toBe('closed')
  }, 60_000)

  it('controle: exit 0 + grupo terminado (sonda real) chega a DONE e o close libera na primeira', async () => {
    cli = await createFakeCli({ default: { kind: 'ok' } })
    h = await createHarness({
      mission: MISSION,
      gates: GATES,
      factory: cli.factory,
      safetyIntervalMs: 0,
    })
    const harness = h
    await harness.orchestrator.drain()
    expect((await harness.task('T01')).status).toBe('DONE')
    await harness.plane.close()
    expect(harness.plane.lifecycle).toBe('closed')
  }, 60_000)
})
