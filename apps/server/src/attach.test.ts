import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServerHarness, type ServerHarness } from './__fixtures__/harness.js'
import { attachServer, type RunningServer } from './server.js'

let harness: ServerHarness | undefined
let running: RunningServer | undefined

afterEach(async () => {
  await running?.close().catch(() => undefined)
  running = undefined
  await harness?.cleanup()
  harness = undefined
})

async function attach(active: ServerHarness): Promise<RunningServer> {
  return attachServer({
    plane: active.plane,
    project: active.project,
    projectText: await readFile(join(active.root, '.agentic', 'project.yaml'), 'utf8'),
    gatesText: await readFile(join(active.root, '.agentic', 'gates.yaml'), 'utf8'),
    repoRoot: active.root,
    port: 0,
  })
}

function portOf(server: RunningServer): number {
  const address = server.app.server.address()
  if (address === null || typeof address === 'string') throw new Error('servidor sem porta')
  return address.port
}

describe('attachServer: API sobre um control plane que ja existe', () => {
  it('publica a API sem criar um segundo control plane (I7)', async () => {
    harness = await createServerHarness()
    running = await attach(harness)

    expect(running.plane).toBe(harness.plane)
    const response = await fetch(`http://127.0.0.1:${portOf(running)}/api/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok' })
  })

  it('`close` fecha o servidor e NAO o plane: quem abriu continua dono', async () => {
    harness = await createServerHarness()
    running = await attach(harness)
    await running.close()
    running = undefined

    // O plane segue utilizavel: se tivesse sido fechado, esta consulta lancaria.
    expect(harness.plane.persistence.queries.listRuns()).toEqual([])
  })

  it('recusa bind fora do loopback sem flag explicita', async () => {
    harness = await createServerHarness()
    await expect(
      attachServer({
        plane: harness.plane,
        project: harness.project,
        projectText: '',
        gatesText: '',
        repoRoot: harness.root,
        host: '0.0.0.0',
        port: 0,
      }),
    ).rejects.toMatchObject({ code: 'BIND_NOT_ALLOWED' })
  })
})
