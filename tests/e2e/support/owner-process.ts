/**
 * UM control plane, num PROCESSO de sistema operacional de verdade.
 *
 * Faz exatamente o que `agentic serve` faz por dentro: `startServer` abre o banco, publica
 * HTTP numa porta EFEMERA, grava `control-plane.json` e adota os runs recuperaveis. Nao ha
 * agente real envolvido — o `project.yaml` do fixture so declara fornecedores in-process.
 *
 * Reporta UMA linha JSON no stdout (dono ou recusa) e fica vivo ate SIGTERM. Duas
 * instancias no mesmo processo nao provariam nada: I13 ja e por instancia. O que D4 pergunta
 * so tem resposta com dois processos separados sobre o MESMO `.agentic/state.db`.
 */
import nodeProcess from 'node:process'
import { startServer } from '@agentic/server'

export interface OwnerReport {
  readonly label: string
  readonly pid: number
  /** `false` = este processo NAO virou control plane; `error` diz por que. */
  readonly ok: boolean
  readonly url?: string
  readonly dbPath?: string
  readonly adopted?: readonly { readonly runId: string; readonly status: string }[]
  readonly refused?: readonly { readonly runId: string; readonly reason: string }[]
  readonly error?: string
}

async function main(): Promise<void> {
  const repoRoot = nodeProcess.argv[2]
  const port = Number(nodeProcess.argv[3] ?? '0')
  const label = nodeProcess.argv[4] ?? '?'
  if (repoRoot === undefined) throw new Error('uso: owner-process.ts <repoRoot> <port> <label>')

  const report = (value: OwnerReport): void => {
    nodeProcess.stdout.write(`${JSON.stringify(value)}\n`)
  }

  let running: Awaited<ReturnType<typeof startServer>>
  try {
    running = await startServer({ repoRoot, port, webDist: repoRoot })
  } catch (error) {
    // Recusar e um desfecho legitimo — e o desfecho que D4 ainda NAO produz.
    report({
      label,
      pid: nodeProcess.pid,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }

  report({
    label,
    pid: nodeProcess.pid,
    ok: true,
    url: running.url,
    dbPath: running.plane.persistence.database.path,
    adopted: (running.adoption?.adopted ?? []).map((entry) => ({
      runId: entry.runId,
      status: entry.status,
    })),
    refused: (running.adoption?.refused ?? []).map((entry) => ({
      runId: entry.runId,
      reason: entry.reason,
    })),
  })

  await new Promise<void>((resolve) => {
    nodeProcess.once('SIGTERM', () => resolve())
    nodeProcess.once('SIGINT', () => resolve())
  })
  await running.close().catch(() => undefined)
}

await main()
