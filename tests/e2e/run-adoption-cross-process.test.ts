import { startServer } from '@agentic/server'
import { describe, expect, it } from 'vitest'
import type { StepFn } from './support/agents.js'
import { pass, review } from './support/agents.js'
import { ENTREGAS } from './support/entregas.js'
import { createMissionHarness } from './support/harness.js'

/**
 * O LIMITE de I13, escrito como teste para nao virar nota de rodape esquecida.
 *
 * A adocao garante UM dono por run DENTRO de uma instancia do control plane. Ela nao
 * garante nada entre processos: dois `agentic serve` sobre o mesmo projeto adotam o MESMO
 * run e viram dois donos, cada um convencido de ser o unico. Isto e D4 e continua aberto —
 * e agora e pior de propria conta, porque antes a duplicacao exigia um comando humano em
 * cada processo e agora acontece sozinha no boot.
 *
 * Este teste NAO conserta nada. Ele fixa a limitacao para que a proxima fatia a encontre
 * falhando de forma barulhenta quando o dono unico entre processos existir.
 */

const lento: StepFn = (context) => {
  if (context.kind === 'review') return review('PASS')
  return pass(`${context.taskId}: entrega lenta`, ENTREGAS[context.taskId] ?? {}, 60_000)
}

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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

describe('D4 — a adocao NAO tem garantia entre processos', () => {
  it('dois control planes sobre o mesmo projeto adotam o MESMO run', async () => {
    const h = await createMissionHarness({ step: lento, project: comAgentesInProcess })
    try {
      await h.start()
      h.orchestrator.start()
      const limite = Date.now() + 30_000
      while ((await h.tasks()).every((task) => task.status !== 'RUNNING')) {
        if (Date.now() > limite) throw new Error('nenhuma task chegou a RUNNING')
        await sleep(20)
      }
      await h.plane.close()

      const a = await startServer({
        repoRoot: h.root,
        port: 0,
        publishRuntimeFile: false,
        webDist: h.root,
      })
      const b = await startServer({
        repoRoot: h.root,
        port: 0,
        publishRuntimeFile: false,
        webDist: h.root,
      })
      try {
        // Nenhum dos dois foi recusado, e ambos assumiram o mesmo run: o dono e unico por
        // INSTANCIA, nao por projeto. Enquanto isto passar, D4 esta aberto.
        expect(a.adoption?.adopted.map((entry) => entry.runId)).toEqual([h.runId])
        expect(b.adoption?.adopted.map((entry) => entry.runId)).toEqual([h.runId])
        expect(a.url).not.toBe(b.url)
        expect(a.plane).not.toBe(b.plane)
      } finally {
        await b.close()
        await a.close()
      }
    } finally {
      await h.cleanup().catch(() => undefined)
    }
  }, 240_000)
})
