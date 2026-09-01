import { join } from 'node:path'
import { acquireControlPlaneOwnership, type ControlPlaneLease } from '@agentic/persistence'
import { writeControlPlaneFile } from '@agentic/server'
import { afterEach, describe, expect, it } from 'vitest'
import { captureDeps, createWorkspace, type Workspace } from '../__fixtures__/harness.js'
import { EXIT_OK } from '../result.js'
import { missionStartCommand } from './mission-start.js'
import { serveCommand } from './serve.js'

/**
 * I14 pelo lado de quem digita.
 *
 * A garantia so vale se o segundo comando explicar o que aconteceu. Um `agentic serve` que
 * morre com stack trace porque o projeto ja tem dono seria tecnicamente correto e
 * praticamente inutil: o usuario nao saberia que basta abrir o dashboard que ja esta no ar.
 */

let workspace: Workspace | undefined
let lease: ControlPlaneLease | undefined

afterEach(async () => {
  lease?.release()
  lease = undefined
  await workspace?.cleanup()
  workspace = undefined
})

/** Ocupa o projeto como um control plane vivo faria — a posse de verdade, nao um dublê. */
async function projetoJaPossuido(
  options: { readonly publicaDescoberta?: boolean } = {},
): Promise<Workspace> {
  const criado = await createWorkspace()
  workspace = criado
  const baseDir = join(criado.dir, '.agentic')
  const outcome = acquireControlPlaneOwnership({ baseDir })
  if (!outcome.ok) throw new Error('fixture: nao consegui ocupar o projeto')
  lease = outcome.lease
  if (options.publicaDescoberta !== false) {
    await writeControlPlaneFile(baseDir, {
      host: '127.0.0.1',
      port: 4410,
      instanceId: outcome.lease.instanceId,
      repoRoot: criado.dir,
    })
  }
  return criado
}

describe('`agentic serve` quando o projeto ja tem dono', () => {
  it('nao sobe um segundo control plane: informa o que ja esta no ar', async () => {
    const criado = await projetoJaPossuido()
    // Ninguem responde no endereco: e assim que o segundo processo descobre que precisa
    // tentar subir, e e aqui que a posse o barra.
    const captured = captureDeps({ cwd: criado.dir, connect: () => Promise.resolve(undefined) })

    const result = await serveCommand({}, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(result.data).toMatchObject({ running: true, reused: true })
    expect(captured.stdout()).toContain('control plane ja no ar em http://127.0.0.1:4410')
    expect(captured.stdout()).toContain('nada a fazer')
  })

  it('`--port` nao compra posse: o endereco informado e o do dono, nao o pedido', async () => {
    const criado = await projetoJaPossuido()
    const captured = captureDeps({ cwd: criado.dir, connect: () => Promise.resolve(undefined) })

    const result = await serveCommand({ port: 4599 }, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(result.data).toMatchObject({ endpoint: 'http://127.0.0.1:4410', reused: true })
    // O usuario precisa ler exatamente isto: a flag nao e um jeito de ter dois.
    expect(captured.stdout()).toContain('`--port` nao cria um segundo control plane')
    expect(captured.stdout()).not.toContain('4599')
  })

  it('sem endereco publicado ainda, diz isso em vez de inventar um', async () => {
    const criado = await projetoJaPossuido({ publicaDescoberta: false })
    const captured = captureDeps({ cwd: criado.dir, connect: () => Promise.resolve(undefined) })

    const result = await serveCommand({}, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(captured.stdout()).toContain('ainda nao publicou o endereco')
  })
})

describe('`agentic mission start` quando o projeto ja tem dono', () => {
  it('recusa abrir um segundo control plane em primeiro plano', async () => {
    const criado = await projetoJaPossuido({ publicaDescoberta: false })
    const captured = captureDeps({ cwd: criado.dir, connect: () => Promise.resolve(undefined) })

    const result = await missionStartCommand(
      { file: criado.missionPath, actor: 'humano' },
      captured.deps,
    )

    expect(result.error?.code).toBe('OWNERSHIP_ALREADY_HELD')
    expect(result.error?.message).toContain('um projeto tem um dono so')
  })
})
