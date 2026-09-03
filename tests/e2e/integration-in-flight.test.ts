import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { acquireControlPlaneOwnership, openPersistence } from '@agentic/persistence'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMissionHarness, type MissionHarness } from './support/harness.js'
import { withScriptedProviders } from './support/providers.js'

/**
 * STABILITY-SLICE-004 / D6 — INTEGRACAO em voo quando o control plane encerra.
 *
 * A integracao e a UNICA etapa cujo efeito e irreversivel e vive fora da worktree da
 * tentativa: `git rebase` + fast-forward da branch da missao. Se o encerramento chega no
 * meio, hoje o `abandon()` ate espera o job terminar — mas o resultado e DESCARTADO, porque
 * a caixa de entrada ja esta fechada. O disco fica assim: branch da missao com o merge feito,
 * task ainda `INTEGRATING`. O proximo dono reconcilia a tentativa como INTERRUPTED, reprova a
 * task e tenta de novo um trabalho que ja esta integrado.
 *
 * A sonda controla o ponto de espera com um `git` de mentira na frente do PATH: `rebase`
 * espera um sinal do teste; todo o resto e o git de verdade. Nenhum agente real e invocado.
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

let shimDir: string
let pathOriginal: string | undefined
let entrou: string
let segue: string

beforeAll(async () => {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  shimDir = await realpath(await mkdtemp(join(tmpdir(), 'agentic-git-shim-')))
  entrou = join(shimDir, 'rebase-entrou')
  segue = join(shimDir, 'rebase-segue')
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "rebase" ] && [ "$2" != "--abort" ]; then',
    `  : > "${entrou}"`,
    `  while [ ! -e "${segue}" ]; do sleep 0.05; done`,
    'fi',
    `exec "${realGit}" "$@"`,
    '',
  ].join('\n')
  await writeFile(join(shimDir, 'git'), script, 'utf8')
  await chmod(join(shimDir, 'git'), 0o755)
  pathOriginal = nodeProcess.env.PATH
  nodeProcess.env.PATH = `${shimDir}:${pathOriginal ?? ''}`
})

afterAll(async () => {
  if (pathOriginal !== undefined) nodeProcess.env.PATH = pathOriginal
  await rm(shimDir, { recursive: true, force: true })
})

describe.skipIf(nodeProcess.platform === 'win32')('D6 — integracao em voo no encerramento', () => {
  let harness: MissionHarness | undefined

  afterAll(async () => {
    await harness?.cleanup().catch(() => undefined)
  })

  it('o resultado observado da integracao e persistido antes de devolver o projeto', async () => {
    harness = await createMissionHarness({ project: withScriptedProviders })
    const h = harness
    await h.start()
    h.orchestrator.start()
    await esperar('a primeira integracao entrar no rebase', () => existe(entrou))

    // Encerramento pedido com o rebase em voo. Ele nao pode resolver antes do rebase.
    const closing = h.plane.close()
    const cedo = await Promise.race([
      closing.then(() => 'resolveu' as const),
      sleep(300).then(() => 'pendente' as const),
    ])
    await writeFile(segue, '', 'utf8')
    await closing

    // O plane fechou: o disco e lido por uma conexao propria, somente leitura.
    const frio = openPersistence({ baseDir: join(h.root, '.agentic'), mode: 'readonly' })
    const tasks = await frio.runs.loadTaskRuns(h.runId).finally(() => frio.close())
    const integrando = tasks.filter((task) => task.status === 'INTEGRATING').map((t) => t.taskId)
    const feitas = tasks.filter((task) => task.status === 'DONE').map((t) => t.taskId)
    const commits = await h.git('rev-list', '--count', 'main..mission/EXEMPLO-001')
    // O disco tem de contar UMA historia: cada merge na branch da missao e uma task DONE.
    expect({ cedo, integrando, merges: Number(commits), feitas: feitas.length }).toEqual({
      cedo: 'pendente',
      integrando: [],
      merges: feitas.length,
      feitas: Number(commits),
    })
    expect(feitas.length).toBeGreaterThan(0)

    // O proximo dono continua de onde parou: a task integrada NAO e refeita.
    harness = await h.reopen()
    const proximo = harness
    proximo.orchestrator.start()
    await esperar(
      'o run progredir sob o novo dono',
      async () =>
        (await proximo.tasks()).some((task) => task.taskId === 'T03' && task.status !== 'PENDING'),
      60_000,
    )
    proximo.orchestrator.stop()
    for (const taskId of feitas) {
      expect(
        (await proximo.attempts(taskId)).length,
        `${taskId} nao pode ganhar tentativa nova`,
      ).toBe(1)
    }
  }, 180_000)
})

/** Reduz a missao do fixture a UMA task sem mission gate: a ultima integracao e a primeira. */
function missaoDeUmaTask(missionText: string): string {
  const inicio = missionText.indexOf('  - id: T02')
  const fim = missionText.indexOf('missionGate:')
  if (inicio === -1 || fim === -1) throw new Error('fixture: nao achei as tasks da missao')
  return missionText.slice(0, inicio) + missionText.slice(fim).replace('missionGate: mission', '')
}

describe.skipIf(nodeProcess.platform === 'win32')(
  'colheita no encerramento (I12 e falha de escrita)',
  () => {
    let harness: MissionHarness | undefined

    afterAll(async () => {
      await harness?.cleanup().catch(() => undefined)
    })

    it('colher a ULTIMA integracao nao leva o run a VERIFYING: fica RUNNING para o proximo dono derivar', async () => {
      await rm(entrou, { force: true })
      await rm(segue, { force: true })
      harness = await createMissionHarness({
        project: withScriptedProviders,
        mission: missaoDeUmaTask,
      })
      const h = harness
      await h.start({ acceptWarnings: true })
      h.orchestrator.start()
      await esperar('a integracao entrar no rebase', () => existe(entrou))
      const closing = h.plane.close()
      await sleep(200)
      await writeFile(segue, '', 'utf8')
      await closing

      const frio = openPersistence({ baseDir: join(h.root, '.agentic'), mode: 'readonly' })
      try {
        const run = await frio.runs.loadRun(h.runId)
        const tasks = await frio.runs.loadTaskRuns(h.runId)
        // Task DONE (o merge foi gravado) e run AINDA RUNNING: nao ha gate em voo para
        // sustentar um VERIFYING, entao ele nao e escrito (I12).
        expect({ run: run?.status, tasks: tasks.map((t) => t.status) }).toEqual({
          run: 'RUNNING',
          tasks: ['DONE'],
        })
      } finally {
        frio.close()
      }

      // O proximo dono deriva no primeiro tick: o run sai de RUNNING, o mission gate roda UMA
      // vez sob ele (o do fixture confere os oito modulos e reprova com uma task so — o
      // veredito do gate nao esta em teste aqui), e a task integrada NAO e refeita.
      harness = await h.reopen()
      await harness.orchestrator.drain()
      const final = await harness.run()
      const missionGates = (await harness.events()).filter(
        (event) => event.type === 'gate.started' && event.payload.scope === 'mission',
      )
      expect({
        terminal: ['COMPLETED', 'FAILED'].includes(final.status),
        gates: missionGates.length,
        tentativasT01: (await harness.attempts('T01')).length,
      }).toEqual({ terminal: true, gates: 1, tentativasT01: 1 })
    }, 180_000)

    it('falha ao gravar a integracao colhida NAO e engolida: close rejeita, o proximo close grava', async () => {
      await harness?.cleanup().catch(() => undefined)
      await rm(entrou, { force: true })
      await rm(segue, { force: true })
      harness = await createMissionHarness({
        project: withScriptedProviders,
        mission: missaoDeUmaTask,
      })
      const h = harness
      await h.start({ acceptWarnings: true })
      h.orchestrator.start()
      await esperar('a integracao entrar no rebase', () => existe(entrou))

      // A transacao que marca a task DONE falha UMA vez — disco cheio, banco ocupado.
      const runs = h.plane.persistence.runs
      const original = runs.withTransaction.bind(runs)
      let falhas = 0
      const { vi } = await import('vitest')
      vi.spyOn(runs, 'withTransaction').mockImplementation((work) =>
        original(async (uow) => {
          const proxy = new Proxy(uow, {
            get(target, prop) {
              const bind = (value: unknown): unknown =>
                typeof value === 'function'
                  ? (value as (...args: unknown[]) => unknown).bind(target)
                  : value
              if (prop === 'saveTaskRun') {
                const save = bind(Reflect.get(target, prop, target)) as (task: {
                  readonly status: string
                }) => Promise<void>
                return (task: { readonly status: string }) => {
                  if (task.status === 'DONE' && falhas === 0) {
                    falhas += 1
                    throw new Error('disco cheio ao gravar a task DONE')
                  }
                  return save(task)
                }
              }
              return bind(Reflect.get(target, prop, target))
            },
          })
          return work(proxy as typeof uow)
        }),
      )

      const primeiro = h.plane.close()
      await sleep(200)
      await writeFile(segue, '', 'utf8')
      await expect(primeiro).rejects.toThrow('disco cheio')
      // Posse retida: o lease ainda esta com este processo, e o plane continua "closing".
      expect(h.lease.held).toBe(true)
      expect(h.plane.lifecycle).toBe('closing')
      const outro = acquireControlPlaneOwnership({ baseDir: join(h.root, '.agentic') })
      expect(outro.ok).toBe(false)

      // O close seguinte grava o que ficou na caixa e termina limpo.
      await h.plane.close()
      expect(h.plane.lifecycle).toBe('closed')
      vi.restoreAllMocks()
      const frio = openPersistence({ baseDir: join(h.root, '.agentic'), mode: 'readonly' })
      try {
        const tasks = await frio.runs.loadTaskRuns(h.runId)
        expect(tasks.map((t) => t.status)).toEqual(['DONE'])
      } finally {
        frio.close()
      }
    }, 180_000)
  },
)
