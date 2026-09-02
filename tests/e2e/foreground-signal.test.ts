import { readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { acquireControlPlaneOwnership, openPersistence } from '@agentic/persistence'
import { afterAll, describe, expect, it } from 'vitest'
import { runCli, spawnCli } from './support/cross-process.js'
import { type Fixture, materializeFixture } from './support/fixture.js'

/**
 * STABILITY-SLICE-004 — Ctrl+C em `mission start` com trabalho em voo.
 *
 * A revisao independente encontrou o buraco: o supervisor de primeiro plano so assinava o
 * sinal quando o run PAUSAVA. Com agente, gate ou `workspaceSetup` em voo, o Node matava o
 * processo pelo tratador padrao, o SO soltava a posse e o efeito continuava — o oposto de I15.
 *
 * Aqui o efeito em voo e um `workspaceSetup` que dorme (e escreve o proprio pid), disparado
 * pela CLI DE VERDADE num processo separado. O sinal tem de levar ao encerramento gracioso:
 * a CLI termina sozinha, o comando do setup morre, e a posse fica livre.
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

async function esperar(label: string, predicate: () => Promise<boolean>, timeoutMs = 60_000) {
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

const marker = join(tmpdir(), `agentic-setup-${nodeProcess.pid}-${Date.now()}`)

/** Fornecedores in-process e um setup que dorme 20s escrevendo o proprio pid. */
function projetoComSetupLento(projectText: string): string {
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
  const trocado = projectText.slice(0, inicio) + bloco + projectText.slice(fim)
  const js = `require('node:fs').writeFileSync('${marker}', String(process.pid)); setTimeout(() => {}, 20000)`
  return trocado.replace(
    '    commands: []',
    ['    commands:', `      - run: node -e "${js}"`, '        timeoutMs: 600000'].join('\n'),
  )
}

let fixture: Fixture | undefined

afterAll(async () => {
  await rm(marker, { force: true })
  await fixture?.cleanup().catch(() => undefined)
})

describe.skipIf(nodeProcess.platform === 'win32')('B3. dois Ctrl+C durante o drain', () => {
  it('o segundo sinal e absorvido: o encerramento gracioso termina, o setup morre, a posse fica livre', async () => {
    await rm(marker, { force: true })
    fixture = await materializeFixture({ project: projetoComSetupLento })
    const missionPath = '.agentic/missions/EXEMPLO-001.mission.yaml'
    const aprovado = await runCli(fixture.root, [
      'mission',
      'approve',
      missionPath,
      '--actor',
      'e2e',
    ])
    expect(aprovado.code).toBe(0)
    const cli = await spawnCli(
      fixture.root,
      ['mission', 'start', missionPath, '--accept-warnings', '--no-serve'],
      /run \S+ iniciado/,
    )
    await esperar('o workspaceSetup entrar em execucao', () => existe(marker))
    const setupPid = Number(await readFile(marker, 'utf8'))

    // Primeiro Ctrl+C inicia o drain; o segundo chega 150ms depois, com o drain em curso.
    nodeProcess.kill(cli.pid, 'SIGINT')
    await sleep(150)
    await cli.stop('SIGINT')

    const posse = acquireControlPlaneOwnership({ baseDir: join(fixture.root, '.agentic') })
    if (posse.ok) posse.lease.release()
    expect({
      setupVivo: vivo(setupPid),
      posseLivre: posse.ok,
      // Encerrou pelo caminho gracioso, nao pelo tratador padrao do Node.
      saida: cli.output().includes('status final'),
    }).toEqual({ setupVivo: false, posseLivre: true, saida: true })
    await fixture.cleanup()
    fixture = undefined
  }, 180_000)
})

describe.skipIf(nodeProcess.platform === 'win32')(
  'Ctrl+C em `mission start` com setup em voo',
  () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      it(`${signal}: a CLI encerra pelo caminho gracioso, mata o setup e devolve a posse`, async () => {
        await rm(marker, { force: true })
        fixture = await materializeFixture({ project: projetoComSetupLento })
        const missionPath = '.agentic/missions/EXEMPLO-001.mission.yaml'
        const aprovado = await runCli(fixture.root, [
          'mission',
          'approve',
          missionPath,
          '--actor',
          'e2e',
        ])
        expect(aprovado.code).toBe(0)

        const cli = await spawnCli(
          fixture.root,
          ['mission', 'start', missionPath, '--accept-warnings', '--no-serve'],
          /run \S+ iniciado/,
        )
        await esperar('o workspaceSetup entrar em execucao', () => existe(marker))
        const setupPid = Number(await readFile(marker, 'utf8'))
        expect(vivo(setupPid)).toBe(true)

        const inicio = Date.now()
        await cli.stop(signal)
        const duracao = Date.now() - inicio

        const posse = acquireControlPlaneOwnership({ baseDir: join(fixture.root, '.agentic') })
        if (posse.ok) posse.lease.release()
        const frio = openPersistence({ baseDir: join(fixture.root, '.agentic'), mode: 'readonly' })
        let tasks: readonly string[]
        try {
          const rows = frio.queries.listRuns({ limit: 1 })
          const runId = rows[0]?.id as never
          tasks = (await frio.runs.loadTaskRuns(runId)).map((t) => t.status)
        } finally {
          frio.close()
        }
        expect({
          encerrouEmTempo: duracao < 30_000,
          setupVivo: vivo(setupPid),
          posseLivre: posse.ok,
          // O despacho foi interrompido durante o `acquire`: nada foi gravado, a task continua READY.
          algumaRunning: tasks.includes('RUNNING'),
          saida: cli.output().includes('status final'),
        }).toEqual({
          encerrouEmTempo: true,
          setupVivo: false,
          posseLivre: true,
          algumaRunning: false,
          saida: true,
        })
        await fixture.cleanup()
        fixture = undefined
      }, 180_000)
    }
  },
)
