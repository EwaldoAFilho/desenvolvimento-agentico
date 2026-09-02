import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { acquireControlPlaneOwnership, openPersistence } from '@agentic/persistence'
import { readControlPlaneFile } from '@agentic/server'
import { describe, expect, it } from 'vitest'
import { pass, review, type StepFn } from './support/agents.js'
import { adopters, type SpawnedOwner, spawnOwner } from './support/cross-process.js'
import { ENTREGAS } from './support/entregas.js'
import { createMissionHarness, type MissionHarness } from './support/harness.js'

/**
 * STABILITY-SLICE-004 — o ciclo de vida do SERVICO, entre processos de verdade.
 *
 * Cada dono aqui e um processo de sistema operacional executando `startServer`, o mesmo
 * caminho de `agentic serve`. Nenhum agente real e invocado. O que se mede:
 *
 * - SIGINT e SIGTERM com um run RUNNING: o dono drena, devolve a posse, e o proximo assume
 *   e faz o run andar (restart = stop gracioso + start + adocao);
 * - SIGKILL com um run RUNNING: nada e drenado, e mesmo assim o proximo assume e recupera;
 * - a posse SO e devolvida depois da drenagem: com um mission gate em voo que ignora
 *   SIGTERM, ninguem consegue a posse antes de o `close` do dono resolver;
 * - mission gate em voo + queda abrupta: o proximo dono refaz o gate do zero e o run termina
 *   com UMA execucao (Fase 21).
 */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const existe = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

async function esperar(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const limite = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > limite) throw new Error(`esperei ${label} por ${timeoutMs}ms`)
    await sleep(25)
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

/** Fornecedores in-process no `project.yaml` do fixture: nenhuma CLI real, zero quota. */
function comAgentesInProcess(projectText: string): string {
  const inicio = projectText.indexOf('  default: claude-code')
  const fim = projectText.indexOf('\ngates:')
  if (inicio === -1 || fim === -1) throw new Error('fixture: bloco de providers nao encontrado')
  const bloco = [
    '  default: alfa',
    '  registry:',
    '    alfa:',
    '      kind: inprocess',
    '      maxConcurrent: 3',
    '      roles: [executor, reviewer]',
    '    beta:',
    '      kind: inprocess',
    '      maxConcurrent: 2',
    '      roles: [executor, reviewer]',
    '',
  ].join('\n')
  return projectText.slice(0, inicio) + bloco + projectText.slice(fim)
}

/** Agente lento: fica em voo enquanto o control plane cai. */
const lento: StepFn = (context) => {
  if (context.kind === 'review') return review('PASS')
  return pass(`${context.taskId}: entrega lenta`, ENTREGAS[context.taskId] ?? {}, 60_000)
}

const agenticDe = (h: MissionHarness): string => join(h.root, '.agentic')

/** O DISCO, por uma conexao propria somente leitura. */
async function frio<T>(
  h: MissionHarness,
  read: (p: ReturnType<typeof openPersistence>) => Promise<T>,
): Promise<T> {
  const p = openPersistence({ baseDir: agenticDe(h), mode: 'readonly' })
  try {
    return await read(p)
  } finally {
    p.close()
  }
}

/** Posse livre AGORA? Tenta e devolve na hora. */
function posseLivre(h: MissionHarness): boolean {
  const outcome = acquireControlPlaneOwnership({ baseDir: agenticDe(h) })
  if (outcome.ok) outcome.lease.release()
  return outcome.ok
}

/**
 * Projeto sem dono com um run RUNNING e uma tentativa que ficou em voo: o retrato de um
 * control plane que caiu no meio do trabalho.
 */
async function projetoComRunEmVoo(): Promise<MissionHarness> {
  const harness = await createMissionHarness({ step: lento, project: comAgentesInProcess })
  await harness.start()
  harness.orchestrator.start()
  await esperar('uma task chegar a RUNNING', async () =>
    (await harness.tasks()).some((task) => task.status === 'RUNNING'),
  )
  await harness.plane.close()
  harness.lease.release()
  return harness
}

async function encerrar(owners: readonly SpawnedOwner[]): Promise<void> {
  for (const owner of owners) await owner.stop().catch(() => undefined)
}

describe('restart entre processos com run RUNNING (Fases 15, 16 e 17)', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`${signal}: A drena e devolve; B assume, reconcilia a tentativa antiga e o run anda`, async () => {
      const harness = await projetoComRunEmVoo()
      const owners: SpawnedOwner[] = []
      try {
        const a = await spawnOwner(harness.root, { label: 'A' })
        expect(adopters([a], harness.runId)).toEqual(['A'])
        const eventosComA = await frio(
          harness,
          async (p) => (await p.events.list(harness.runId)).length,
        )

        const parada = await a.stop(signal)
        expect(parada.ok).toBe(true)
        expect(posseLivre(harness)).toBe(true)
        expect(await readControlPlaneFile(agenticDe(harness))).toBeUndefined()

        const b = await spawnOwner(harness.root, { label: 'B' })
        owners.push(b)
        expect(adopters([b], harness.runId)).toEqual(['B'])
        expect(b.report.instanceId).not.toBe(a.report.instanceId)
        await esperar(
          'o run andar sob B',
          async () =>
            (await frio(harness, async (p) => (await p.events.list(harness.runId)).length)) >
            eventosComA,
          30_000,
        )
        // A tentativa que estava em voo quando o primeiro processo caiu foi reconciliada:
        // nenhuma tentativa sobrevive a dois donos.
        const attempts = await frio(harness, (p) => p.runs.loadAttempts(harness.runId))
        const interrompidas = attempts.filter(
          (attempt) => attempt.failureReason?.code === 'INTERRUPTED',
        )
        expect(interrompidas.length).toBeGreaterThan(0)
      } finally {
        await encerrar(owners)
        await harness.cleanup().catch(() => undefined)
      }
    }, 180_000)
  }

  it('SIGKILL: nada drena, e mesmo assim B assume e recupera o run', async () => {
    const harness = await projetoComRunEmVoo()
    const owners: SpawnedOwner[] = []
    try {
      const a = await spawnOwner(harness.root, { label: 'A' })
      expect(adopters([a], harness.runId)).toEqual(['A'])
      await a.kill()
      expect(posseLivre(harness)).toBe(true)
      // A descoberta ficou velha no disco: nao e posse, nao atrapalha (ADR-0013).
      expect((await readControlPlaneFile(agenticDe(harness)))?.instanceId).toBe(a.report.instanceId)

      const b = await spawnOwner(harness.root, { label: 'B' })
      owners.push(b)
      expect(adopters([b], harness.runId)).toEqual(['B'])
      await esperar(
        'B reconciliar o que A deixou em voo',
        async () =>
          (await frio(harness, (p) => p.runs.loadAttempts(harness.runId))).every(
            (attempt) =>
              attempt.finishedAt !== undefined || attempt.startedAt.getTime() > Date.now() - 60_000,
          ),
        30_000,
      )
      expect((await readControlPlaneFile(agenticDe(harness)))?.instanceId).toBe(b.report.instanceId)
    } finally {
      await encerrar(owners)
      await harness.cleanup().catch(() => undefined)
    }
  }, 180_000)
})

/**
 * Mission gate que IGNORA SIGTERM: o encerramento precisa esperar o SIGKILL do runtime de
 * processo (2s de tolerancia), e e essa janela que deixa medir "a posse so sai depois".
 * O comando escreve o proprio pid no marcador, para o teste perguntar ao SO se ele morreu.
 */
function gatesComMissionGateTeimoso(marker: string): string {
  const js =
    'const fs=require("node:fs");' +
    `fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));` +
    'process.on("SIGTERM",()=>{});' +
    'setTimeout(()=>{},8000)'
  return [
    'apiVersion: agentic/v1',
    'kind: Gates',
    'profiles:',
    '  unit:',
    '    commands:',
    '      - run: node tests/run.js',
    '        timeoutMs: 60000',
    '  mission:',
    '    commands:',
    `      - run: node -e '${js}'`,
    '        timeoutMs: 30000',
    '      - run: node tests/run.js',
    '        timeoutMs: 120000',
    'env:',
    '  allow: [PATH, HOME, LANG, TMPDIR]',
    '',
  ].join('\n')
}

/**
 * Projeto sem dono com o run em VERIFYING e NENHUM resultado de mission gate: e o estado
 * que a adocao retoma iniciando o gate do zero (I12).
 */
async function projetoEmVerifying(marker: string): Promise<MissionHarness> {
  const harness = await createMissionHarness({ project: comAgentesInProcess })
  await writeFile(
    join(agenticDe(harness), 'gates.yaml'),
    gatesComMissionGateTeimoso(marker),
    'utf8',
  )
  await harness.start()
  harness.orchestrator.start()
  await esperar(
    'o run chegar a VERIFYING',
    async () => (await harness.run()).status === 'VERIFYING',
    120_000,
  )
  // O plane do teste encerra com o gate (do teste) em voo — e o cancela.
  await harness.plane.close()
  harness.lease.release()
  await rm(marker, { force: true })
  const run = await frio(harness, (p) => p.runs.loadRun(harness.runId))
  if (run?.status !== 'VERIFYING' || run.missionGateExecutionId !== undefined) {
    throw new Error(`fixture: esperava VERIFYING sem resultado, veio ${run?.status}`)
  }
  return harness
}

describe('a posse so e devolvida depois da drenagem (Fases 10, 14 e 15)', () => {
  it('B nao consegue a posse enquanto A ainda drena um mission gate em voo', async () => {
    const marker = join(
      (await import('node:os')).tmpdir(),
      `agentic-gate-${nodeProcess.pid}-${Date.now()}`,
    )
    const harness = await projetoEmVerifying(marker)
    const owners: SpawnedOwner[] = []
    try {
      const a = await spawnOwner(harness.root, { label: 'A' })
      expect(adopters([a], harness.runId)).toEqual(['A'])
      await esperar('o mission gate de A entrar em execucao', () => existe(marker), 60_000)
      const gatePid = Number(await readFile(marker, 'utf8'))
      expect(vivo(gatePid)).toBe(true)

      // SIGTERM em A e, no MESMO instante, uma disputa continua pela posse a partir daqui.
      const sinalEm = Date.now()
      const parando = a.stop('SIGTERM')
      let venceuEm: number | undefined
      while (venceuEm === undefined) {
        const outcome = acquireControlPlaneOwnership({
          baseDir: agenticDe(harness),
          busyTimeoutMs: 0,
        })
        if (outcome.ok) {
          venceuEm = Date.now()
          outcome.lease.release()
          break
        }
        if (Date.now() - sinalEm > 60_000) throw new Error('A nunca devolveu a posse')
        await sleep(5)
      }
      const parada = await parando

      expect(parada.ok).toBe(true)
      expect(parada.closedAt).toBeTypeOf('number')
      // A posse so ficou livre DEPOIS de o close de A resolver — e o close esperou o gate
      // teimoso morrer (SIGTERM ignorado, SIGKILL depois da tolerancia).
      expect(venceuEm).toBeGreaterThanOrEqual(parada.closedAt ?? Number.POSITIVE_INFINITY)
      expect(venceuEm - sinalEm).toBeGreaterThanOrEqual(1_500)
      expect(vivo(gatePid)).toBe(false)
      // E o gate cancelado NAO virou resultado: o run continua VERIFYING, sem execucao.
      const run = await frio(harness, (p) => p.runs.loadRun(harness.runId))
      expect({ status: run?.status, execucao: run?.missionGateExecutionId }).toEqual({
        status: 'VERIFYING',
        execucao: undefined,
      })

      // O proximo dono retoma e conclui, com UMA execucao de mission gate.
      const b = await spawnOwner(harness.root, { label: 'B' })
      owners.push(b)
      expect(adopters([b], harness.runId)).toEqual(['B'])
      await esperar(
        'B concluir o run',
        async () =>
          (await frio(harness, (p) => p.runs.loadRun(harness.runId)))?.status === 'COMPLETED',
        120_000,
      )
      const iniciados = await frio(harness, async (p) =>
        (await p.events.list(harness.runId)).filter(
          (event) => event.type === 'gate.started' && event.payload.scope === 'mission',
        ),
      )
      expect(iniciados).toHaveLength(1)
    } finally {
      await encerrar(owners)
      await rm(marker, { force: true })
      await harness.cleanup().catch(() => undefined)
    }
  }, 300_000)

  it('Fase 21: mission gate em voo + SIGKILL: B refaz o gate do zero e o run termina com UMA execucao', async () => {
    const marker = join(
      (await import('node:os')).tmpdir(),
      `agentic-gate-${nodeProcess.pid}-${Date.now()}-kill`,
    )
    const harness = await projetoEmVerifying(marker)
    const owners: SpawnedOwner[] = []
    try {
      const a = await spawnOwner(harness.root, { label: 'A' })
      await esperar('o mission gate de A entrar em execucao', () => existe(marker), 60_000)
      const gatePid = Number(await readFile(marker, 'utf8'))
      await a.kill()
      expect(posseLivre(harness)).toBe(true)
      // Nada foi drenado: nenhuma execucao chegou ao banco.
      const run = await frio(harness, (p) => p.runs.loadRun(harness.runId))
      expect(run?.missionGateExecutionId).toBeUndefined()

      const b = await spawnOwner(harness.root, { label: 'B' })
      owners.push(b)
      expect(adopters([b], harness.runId)).toEqual(['B'])
      await esperar(
        'B concluir o run',
        async () =>
          (await frio(harness, (p) => p.runs.loadRun(harness.runId)))?.status === 'COMPLETED',
        120_000,
      )
      const eventos = await frio(harness, (p) => p.events.list(harness.runId))
      const iniciados = eventos.filter(
        (event) => event.type === 'gate.started' && event.payload.scope === 'mission',
      )
      const terminados = eventos.filter(
        (event) =>
          event.type === 'gate.finished' &&
          event.payload.gateExecutionId !== 'mission-gate-nao-executado' &&
          event.taskId === undefined,
      )
      expect({ iniciados: iniciados.length, terminados: terminados.length }).toEqual({
        iniciados: 1,
        terminados: 1,
      })
      // Limite declarado do SIGKILL: o comando do gate de A e orfao ate terminar sozinho;
      // ele nao alcanca o banco (a conexao morreu com A) e a worktree da missao e
      // reivindicada por B pela prova de posse (mission-owner).
      await esperar('o gate orfao de A terminar sozinho', async () => !vivo(gatePid), 30_000)
    } finally {
      await encerrar(owners)
      await rm(marker, { force: true })
      await harness.cleanup().catch(() => undefined)
    }
  }, 300_000)
})
