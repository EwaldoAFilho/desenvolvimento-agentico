import { ControlPlaneBusyError, startServer } from '@agentic/server'
import { describe, expect, it } from 'vitest'
import { createMissionHarness } from './support/harness.js'

/**
 * A garantia que faltava a I13, agora que I14 existe.
 *
 * I13 diz que um run recuperavel tem exatamente um dono NAQUELA INSTANCIA. Sozinha, ela nao
 * dizia nada entre processos: dois `agentic serve` sobre o mesmo projeto adotavam o mesmo run
 * e viravam dois donos, cada um convencido de ser o unico — e a adocao automatica no boot
 * fazia isso acontecer sem ninguem pedir.
 *
 * Este arquivo nasceu fixando essa limitacao. Agora ele fixa o contrario: o segundo control
 * plane sobre o mesmo projeto NAO sobe. A prova aqui e no MESMO processo de proposito — se a
 * exclusividade dependesse de processos separados, ela dependeria do sistema operacional
 * distinguir chamadores, e nao e isso que sustenta a posse. A prova entre processos de
 * verdade esta em `control-plane-ownership.test.ts`.
 */

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

describe('I14 — a adocao tem dono unico tambem entre control planes', () => {
  it('o segundo control plane sobre o mesmo projeto e recusado, e o primeiro segue dono', async () => {
    const h = await createMissionHarness({ project: comAgentesInProcess })
    try {
      await h.start()
      await h.plane.pauseRun(h.runId, { actor: 'humano@estoque-cli' })
      // O processo do teste solta o banco E a posse: sobra um projeto sem dono, com um run
      // recuperavel. Sao os control planes abaixo que vao disputa-lo.
      await h.plane.close()
      h.lease.release()

      const a = await startServer({
        repoRoot: h.root,
        port: 0,
        publishRuntimeFile: false,
        webDist: h.root,
      })
      try {
        expect(a.adoption?.adopted.map((entry) => entry.runId)).toEqual([h.runId])
        expect(a.lease?.held).toBe(true)

        // Porta EFEMERA nos dois: nenhum EADDRINUSE participa desta recusa. O que barra o
        // segundo e a posse do projeto, e a mensagem tem de dizer qual projeto.
        const segundo = await startServer({
          repoRoot: h.root,
          port: 0,
          publishRuntimeFile: false,
          webDist: h.root,
        }).then(
          (running) => running,
          (error: unknown) => error,
        )

        expect(segundo).toBeInstanceOf(ControlPlaneBusyError)
        const recusa = segundo as ControlPlaneBusyError
        expect(recusa.code).toBe('OWNERSHIP_ALREADY_HELD')
        expect(recusa.ownedDir).toContain('.agentic')

        // E o dono nao foi perturbado: continua com posse e com o run.
        expect(a.lease?.held).toBe(true)
        expect(a.plane.instanceId).toBe(a.lease?.instanceId)
      } finally {
        await a.close()
      }

      // Encerrado o dono, o projeto volta a estar disponivel — e o run e readotado.
      const b = await startServer({
        repoRoot: h.root,
        port: 0,
        publishRuntimeFile: false,
        webDist: h.root,
      })
      try {
        expect(b.adoption?.adopted.map((entry) => entry.runId)).toEqual([h.runId])
        expect(b.lease?.instanceId).toBeDefined()
      } finally {
        await b.close()
      }
    } finally {
      await h.cleanup().catch(() => undefined)
    }
  }, 240_000)
})
