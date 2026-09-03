/**
 * UM control plane, num PROCESSO de sistema operacional de verdade.
 *
 * Faz exatamente o que `agentic serve` faz por dentro: disputa a posse do projeto, e so
 * entao abre o banco, publica HTTP numa porta EFEMERA, grava `control-plane.json` e adota os
 * runs recuperaveis. Nao ha agente real envolvido — o `project.yaml` do fixture so declara
 * fornecedores in-process.
 *
 * Reporta UMA linha JSON no stdout (posse ou recusa) e fica vivo ate receber sinal. Duas
 * instancias no mesmo processo nao provariam o suficiente: I13 ja e por instancia. O que I14
 * garante so tem prova com dois processos separados sobre o MESMO `.agentic/`.
 */
import nodeProcess from 'node:process'
import { startServer } from '@agentic/server'

export interface OwnerReport {
  readonly label: string
  readonly pid: number
  /** `false` = este processo NAO virou control plane; `code` e `error` dizem por que. */
  readonly ok: boolean
  /** Identidade do dono. A autoridade e a posse, nunca o pid. */
  readonly instanceId?: string
  readonly url?: string
  /** Presente SO quando o processo chegou a abrir banco mutavel. O perdedor nao chega. */
  readonly dbPath?: string
  readonly adopted?: readonly { readonly runId: string; readonly status: string }[]
  readonly refused?: readonly { readonly runId: string; readonly reason: string }[]
  readonly code?: string
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
    // Recusar e um desfecho legitimo: e o que I14 exige do segundo processo.
    const code = (error as { readonly code?: unknown }).code
    report({
      label,
      pid: nodeProcess.pid,
      ok: false,
      ...(typeof code === 'string' ? { code } : {}),
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }

  report({
    label,
    pid: nodeProcess.pid,
    ok: true,
    ...(running.lease === undefined ? {} : { instanceId: running.lease.instanceId }),
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

  // O `vite-node` que executa este processo instala um tratador de SIGTERM que sai na hora
  // (`process.exit`), pulando o encerramento gracioso — em producao o binario roda no Node
  // puro e nao tem esse tratador. Aqui ele e removido para que SIGTERM meca o produto, nao
  // o harness. SIGINT e tratado pelo mesmo motivo, por simetria.
  nodeProcess.removeAllListeners('SIGTERM')
  nodeProcess.removeAllListeners('SIGINT')
  await new Promise<void>((resolve) => {
    nodeProcess.once('SIGTERM', () => {
      resolve()
    })
    nodeProcess.once('SIGINT', () => {
      resolve()
    })
  })
  // Encerramento normal: para de atender, drena os efeitos, fecha o banco e solta a posse
  // (I15). A segunda linha diz QUANDO isso terminou — e o carimbo que o teste compara com o
  // instante em que outro processo conseguiu a posse.
  const closed = await running.close().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error: String(error) }),
  )
  nodeProcess.stdout.write(`${JSON.stringify({ label, closedAt: Date.now(), ...closed })}\n`)
}

await main()
