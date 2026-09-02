import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import type { Assignment, DispatchContext, DomainEvent, Run } from '@agentic/domain'
import { acquireControlPlaneOwnership, openPersistence } from '@agentic/persistence'
import type { ProviderFactory } from '@agentic/providers'
import { afterEach, describe, expect, it } from 'vitest'
import { scriptedFactory } from './__fixtures__/agents.js'
import { createFakeCli, type FakeCli } from './__fixtures__/fake-cli.js'
import { GATE_ALWAYS_PASS } from './__fixtures__/files.js'
import { createHarness, defaultStep, type Harness } from './__fixtures__/harness.js'

/**
 * STABILITY-SLICE-004 — o que o encerramento deixa vivo.
 *
 * A revisao da 003C encontrou dois efeitos que sobrevivem ao `close`, e este arquivo nasceu
 * vermelho medindo os dois — mais o terceiro que a mesma pergunta revela:
 *
 * - **a cadeia do tick (`#chain`) nao e esperada.** `abandon()` espera o retrato de `#jobs`,
 *   mas o tick e serializado a parte. Um tick que ja passou por `#closed` pode estar dentro
 *   de `provider.start()`: `close` resolve, a posse e devolvida, e o tick antigo ainda grava
 *   log, faz commit na worktree e escreve artefato — depois que OUTRO processo assumiu.
 * - **um processo de agente nascido nessa janela nao e cancelado.** O `cancel` de `abandon`
 *   so alcanca handles que JA existiam; o que `start()` devolve depois fica orfao ate o
 *   timeout da tentativa.
 * - **um gate em voo e esperado ate o fim, sem cancelamento.** Um mission gate de dez minutos
 *   segura o encerramento por dez minutos, e o resultado e descartado de qualquer forma.
 *
 * A propriedade que estes testes afirmam (I15): quando `close` resolve, nenhum efeito deste
 * dono muta mais o projeto — nem banco, nem worktree, nem arquivo, nem processo filho.
 */

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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

/** Corrida entre uma promessa e o relogio: diz se ela resolveu CEDO demais. */
async function resolveuEm(promise: Promise<unknown>, ms: number): Promise<'resolveu' | 'pendente'> {
  return Promise.race([
    promise.then(
      () => 'resolveu' as const,
      () => 'resolveu' as const,
    ),
    delay(ms).then(() => 'pendente' as const),
  ])
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

interface Portao {
  readonly entrou: Deferred
  readonly abre: Deferred
}

/**
 * Provider cujo `start()` para num ponto controlado.
 *
 * E exatamente a janela da revisao: o tick esta DENTRO de `provider.start()`, a tentativa ja
 * foi gravada como RUNNING e a worktree ja existe, mas o handle ainda nao foi registrado —
 * entao `abandon()` nao tem o que cancelar e nao tem job para esperar.
 */
function comPortao(inner: ProviderFactory, portao: Portao): ProviderFactory {
  return (input) => {
    const provider = inner(input)
    return {
      id: provider.id,
      capabilities: () => provider.capabilities(),
      health: () => provider.health(),
      start: async (assignment: Assignment, ctx: DispatchContext) => {
        portao.entrou.resolve()
        await portao.abre.promise
        return provider.start(assignment, ctx)
      },
    }
  }
}

const MISSION = { tasks: [{ id: 'T01' }], defaultGate: 'unit', requireReview: false }
const BRANCH_A1 = 'task/DA-TEST-001/T01/a1'
const MISSION_BRANCH = 'mission/DA-TEST-001'

let h: Harness | undefined
let cli: FakeCli | undefined
let tmp: string | undefined
let pidFile: string | undefined

afterEach(async () => {
  // Um processo que o produto deixou orfao nao pode sobreviver ao teste.
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

async function pasta(): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), 'agentic-drain-'))
  return tmp
}

/** O DISCO depois do close, lido por uma conexao propria: o plane fechado nao le mais. */
async function retratoFrio(
  harness: Harness,
): Promise<{ readonly run: Run; readonly events: readonly DomainEvent[] }> {
  const frio = openPersistence({ baseDir: join(harness.root, '.agentic'), mode: 'readonly' })
  try {
    const run = await frio.runs.loadRun(harness.runId)
    if (run === undefined) throw new Error('run sumiu do banco')
    return { run, events: await frio.events.list(harness.runId) }
  } finally {
    frio.close()
  }
}

/** Retrato do que o dono antigo poderia ter mutado depois do `close`. */
async function efeitosDepoisDoClose(harness: Harness): Promise<{
  readonly commitsNaTentativa: string
  readonly artefatosDaTentativa: boolean
  readonly errosDeBancoFechado: number
}> {
  return {
    commitsNaTentativa: await harness.git('rev-list', '--count', `${MISSION_BRANCH}..${BRANCH_A1}`),
    artefatosDaTentativa: existsSync(
      join(harness.root, '.agentic', 'runs', harness.runId, 'attempts'),
    ),
    errosDeBancoFechado: harness.orchestrator.errors.filter((error) =>
      /not open|readonly|READ_ONLY/i.test(String(error)),
    ).length,
  }
}

describe('I15 — close so resolve quando nenhum efeito do dono pode mutar o projeto', () => {
  it('B. tick em voo dentro de provider.start(): close espera a cadeia, e ela nao muta depois', async () => {
    const portao: Portao = { entrou: deferred(), abre: deferred() }
    h = await createHarness({
      mission: MISSION,
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: comPortao(scriptedFactory(defaultStep), portao),
      safetyIntervalMs: 0,
    })
    const harness = h
    // O tick e disparado e para dentro de `provider.start()`: tentativa RUNNING no banco,
    // worktree criada, handle ainda inexistente.
    const tick = harness.orchestrator.tick()
    await portao.entrou.promise

    const closing = harness.plane.close()
    // Encerrar com a cadeia em voo nao pode resolver antes dela.
    const cedo = await resolveuEm(closing, 400)

    // A cadeia segue: hoje ela registra o handle e dispara `#afterExecutor` sobre um banco
    // que ja fechou — log, diff, commit e artefato acontecem DEPOIS do close.
    portao.abre.resolve()
    await closing
    await tick.catch(() => undefined)
    // Depois do close a posse e devolvida: e aqui que outro processo assumiria.
    expect(harness.lease.release()).not.toBe(false)
    await delay(1_500)

    expect({ cedo, ...(await efeitosDepoisDoClose(harness)) }).toEqual({
      cedo: 'pendente',
      commitsNaTentativa: '0',
      artefatosDaTentativa: false,
      errosDeBancoFechado: 0,
    })
    // A tentativa fica RUNNING no banco de proposito: quem reconcilia e o proximo dono.
    const frio = openPersistence({ baseDir: join(harness.root, '.agentic'), mode: 'readonly' })
    try {
      const tasks = await frio.runs.loadTaskRuns(harness.runId)
      expect(tasks.find((task) => task.taskId === 'T01')?.status).toBe('RUNNING')
    } finally {
      frio.close()
    }
  }, 60_000)

  it('C1. processo do agente com handle conhecido: close cancela a arvore inteira (ja vale hoje)', async () => {
    const dir = await pasta()
    pidFile = join(dir, 'pid')
    const neto = join(dir, 'neto')
    cli = await createFakeCli({
      default: { kind: 'hang', pidFile, grandchildTarget: neto, grandchildDelayMs: 1_500 },
    })
    h = await createHarness({
      mission: MISSION,
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: cli.factory,
      safetyIntervalMs: 0,
    })
    const harness = h
    await harness.orchestrator.tick()
    const arquivoPid = pidFile
    await esperar('o processo do agente nascer', () => existsSync(arquivoPid))
    const pid = Number(readFileSync(arquivoPid, 'utf8'))
    expect(vivo(pid)).toBe(true)

    const inicio = Date.now()
    await harness.plane.close()
    const duracao = Date.now() - inicio
    // O neto escreveria em 1,5s se a arvore tivesse sobrevivido.
    await delay(2_000)

    expect({ vivo: vivo(pid), neto: existsSync(neto), rapido: duracao < 10_000 }).toEqual({
      vivo: false,
      neto: false,
      rapido: true,
    })
  }, 60_000)

  it('C2. processo do agente nascido durante o close: tambem e cancelado, nunca orfao', async () => {
    const dir = await pasta()
    pidFile = join(dir, 'pid')
    const neto = join(dir, 'neto')
    cli = await createFakeCli({
      default: { kind: 'hang', pidFile, grandchildTarget: neto, grandchildDelayMs: 1_500 },
    })
    const portao: Portao = { entrou: deferred(), abre: deferred() }
    h = await createHarness({
      mission: MISSION,
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: comPortao(cli.factory, portao),
      safetyIntervalMs: 0,
    })
    const harness = h
    const tick = harness.orchestrator.tick()
    await portao.entrou.promise

    const closing = harness.plane.close()
    const cedo = await resolveuEm(closing, 400)
    portao.abre.resolve()
    await closing
    await tick.catch(() => undefined)

    const arquivoPid = pidFile
    // O processo pode ter chegado a nascer (start() rodou depois do close pedido) — ou ter
    // sido morto antes mesmo de escrever o pid. Os dois desfechos sao aceitaveis; o que nao
    // e aceitavel e um processo vivo.
    await esperar('o processo do agente nascer', () => existsSync(arquivoPid), 3_000).catch(
      () => undefined,
    )
    await delay(2_000)
    const pid = existsSync(arquivoPid) ? Number(readFileSync(arquivoPid, 'utf8')) : undefined

    // ...e nao pode ter sobrevivido ao close: nem ele, nem a arvore dele.
    expect({ cedo, vivo: pid === undefined ? false : vivo(pid), neto: existsSync(neto) }).toEqual({
      cedo: 'pendente',
      vivo: false,
      neto: false,
    })
  }, 60_000)

  it('D. mission gate em voo: close cancela o comando, nao espera o timeout, e nada e persistido', async () => {
    const dir = await pasta()
    pidFile = join(dir, 'gate-pid')
    const concluiu = join(dir, 'gate-done')
    const js =
      'const fs=require("node:fs");' +
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
      `setTimeout(()=>fs.writeFileSync(${JSON.stringify(concluiu)},"x"),3000)`
    h = await createHarness({
      mission: { ...MISSION, missionGate: 'lento' },
      project: { missionGate: 'lento' },
      gates: { unit: [GATE_ALWAYS_PASS], lento: [`node -e '${js}'`] },
      safetyIntervalMs: 0,
    })
    const harness = h
    harness.orchestrator.start()
    const arquivoPid = pidFile
    await esperar('o mission gate entrar em execucao', () => existsSync(arquivoPid), 30_000)
    const pid = Number(readFileSync(arquivoPid, 'utf8'))
    expect((await harness.run()).status).toBe('VERIFYING')

    const inicio = Date.now()
    await harness.plane.close()
    const duracao = Date.now() - inicio
    // O comando escreveria `gate-done` aos 3s se tivesse continuado vivo.
    await delay(3_500)

    const { run, events } = await retratoFrio(harness)
    const gateFinished = events.filter((event) => event.type === 'gate.finished')
    expect({
      rapido: duracao < 2_000,
      processoVivo: vivo(pid),
      comandoConcluiu: existsSync(concluiu),
      status: run.status,
      execucaoPersistida: run.missionGateExecutionId,
      gateFinished: gateFinished.length,
    }).toEqual({
      rapido: true,
      processoVivo: false,
      comandoConcluiu: false,
      status: 'VERIFYING',
      execucaoPersistida: undefined,
      // So o gate da TASK terminou; o da missao foi interrompido e nao deixou execucao.
      gateFinished: 1,
    })

    // Recovery: o proximo dono refaz o gate do zero (I12) e o run termina com UMA execucao.
    h = await harness.reopen()
    await h.orchestrator.drain()
    const final = await h.run()
    const missionGates = (await h.events()).filter(
      (event) => event.type === 'gate.started' && event.payload.scope === 'mission',
    )
    expect({
      status: final.status,
      execucao: typeof final.missionGateExecutionId,
      gates: missionGates.length,
    }).toEqual({ status: 'COMPLETED', execucao: 'string', gates: 1 })
  }, 90_000)

  it('posse: outro dono so entra depois que o close resolveu', async () => {
    const portao: Portao = { entrou: deferred(), abre: deferred() }
    h = await createHarness({
      mission: MISSION,
      gates: { unit: [GATE_ALWAYS_PASS] },
      factory: comPortao(scriptedFactory(defaultStep), portao),
      safetyIntervalMs: 0,
    })
    const harness = h
    const tick = harness.orchestrator.tick()
    await portao.entrou.promise
    const closing = harness.plane.close()
    await resolveuEm(closing, 200)
    portao.abre.resolve()
    await closing
    await tick.catch(() => undefined)
    expect(harness.lease.release()).not.toBe(false)

    // Com a posse devolvida SO depois do close, o segundo dono encontra o projeto quieto.
    const outro = acquireControlPlaneOwnership({ baseDir: join(harness.root, '.agentic') })
    expect(outro.ok).toBe(true)
    if (outro.ok) outro.lease.release()
  }, 60_000)
})
