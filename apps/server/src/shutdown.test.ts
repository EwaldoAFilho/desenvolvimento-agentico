import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServerHarness, type ServerHarness } from './__fixtures__/harness.js'
import { attachServer, type RunningServer } from './server.js'

/**
 * STABILITY-SLICE-004 — o servidor precisa conseguir FECHAR.
 *
 * `app.close()` do Fastify espera as conexoes ativas terminarem, e um stream SSE sequestrado
 * (`reply.hijack()`) e uma conexao ativa que nunca termina sozinha. Medido: com UM cliente do
 * dashboard conectado, o encerramento nao resolve — o `Stop` da extensao ficaria pendurado
 * exatamente no caso comum, que e ter a tela aberta.
 */

let harness: ServerHarness | undefined
let running: RunningServer | undefined
let cliente: http.ClientRequest | undefined

afterEach(async () => {
  cliente?.destroy()
  cliente = undefined
  await running?.close().catch(() => undefined)
  running = undefined
  await harness?.cleanup()
  harness = undefined
})

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

function portOf(server: RunningServer): number {
  const address = server.app.server.address()
  if (address === null || typeof address === 'string') throw new Error('servidor sem porta')
  return address.port
}

/** Abre o stream e resolve quando o primeiro byte chega: a conexao esta de pe. */
function conectarStream(port: number, runId: string): Promise<http.ClientRequest> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: `/api/runs/${runId}/stream` },
      (response) => {
        response.once('data', () => resolve(request))
        response.on('error', () => undefined)
      },
    )
    request.on('error', reject)
  })
}

describe('encerramento com cliente SSE conectado', () => {
  it('close resolve mesmo com o dashboard ouvindo o stream', async () => {
    harness = await createServerHarness()
    running = await attachServer({
      plane: harness.plane,
      project: harness.project,
      projectText: await readFile(join(harness.root, '.agentic', 'project.yaml'), 'utf8'),
      gatesText: await readFile(join(harness.root, '.agentic', 'gates.yaml'), 'utf8'),
      repoRoot: harness.root,
      port: 0,
      heartbeatMs: 100,
    })
    const port = portOf(running)
    const aprovado = await fetch(`http://127.0.0.1:${port}/api/missions/DA-SRV-001/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'humano@teste' }),
    })
    expect(aprovado.status).toBe(200)
    const { runId } = (await aprovado.json()) as { readonly runId: string }
    cliente = await conectarStream(port, runId)

    const inicio = Date.now()
    const fechado = await Promise.race([
      running.close().then(() => 'fechou' as const),
      delay(3_000).then(() => 'pendurado' as const),
    ])
    expect({ fechado, duracao: Date.now() - inicio < 3_000 }).toEqual({
      fechado: 'fechou',
      duracao: true,
    })
    running = undefined
  })
})
