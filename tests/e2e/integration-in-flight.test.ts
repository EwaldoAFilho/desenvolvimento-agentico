import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { openPersistence } from '@agentic/persistence'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMissionHarness, type MissionHarness } from './support/harness.js'

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
    harness = await createMissionHarness({ project: comAgentesInProcess })
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
