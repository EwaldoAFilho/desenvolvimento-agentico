import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { createServerHarness, type ServerHarness } from './__fixtures__/harness.js'
import { discoverControlPlane, readControlPlaneFile } from './control-plane-file.js'
import { attachServer, type RunningServer } from './server.js'

let harness: ServerHarness | undefined
let running: RunningServer | undefined

afterEach(async () => {
  await running?.close().catch(() => undefined)
  running = undefined
  await harness?.cleanup()
  harness = undefined
})

async function attach(
  active: ServerHarness,
  extra: { readonly publishRuntimeFile?: boolean } = {},
): Promise<RunningServer> {
  return attachServer({
    plane: active.plane,
    project: active.project,
    projectText: await readFile(join(active.root, '.agentic', 'project.yaml'), 'utf8'),
    gatesText: await readFile(join(active.root, '.agentic', 'gates.yaml'), 'utf8'),
    repoRoot: active.root,
    port: 0,
    ...extra,
  })
}

function runtimeDirOfHarness(active: ServerHarness): string {
  return join(active.root, '.agentic')
}

describe('publicar HTTP publica tambem onde encontrar o processo', () => {
  it('grava o registro com a porta REAL do socket, nao a porta pedida', async () => {
    harness = await createServerHarness()
    running = await attach(harness)

    const runtime = await readControlPlaneFile(runtimeDirOfHarness(harness))
    expect(runtime).toBeDefined()
    // `port: 0` pede "qualquer porta livre": gravar 0 seria um endereco que nao atende.
    expect(runtime?.port).toBeGreaterThan(0)
    expect(runtime?.url).toBe(running.url)
    expect(runtime?.pid).toBe(nodeProcess.pid)
  })

  it('a descoberta chega a um endereco que responde de verdade', async () => {
    harness = await createServerHarness()
    running = await attach(harness)

    const found = await discoverControlPlane(runtimeDirOfHarness(harness))
    expect(found).toBeDefined()
    const response = await fetch(`${found?.url}/api/health`)
    expect(response.status).toBe(200)
  })

  it('`close` retira o registro: processo encerrado nao fica anunciado', async () => {
    harness = await createServerHarness()
    running = await attach(harness)
    const dir = runtimeDirOfHarness(harness)
    expect(await readControlPlaneFile(dir)).toBeDefined()

    await running.close()
    running = undefined

    expect(await readControlPlaneFile(dir)).toBeUndefined()
  })

  it('a API continua sendo a API: o registro e so um ponteiro', async () => {
    harness = await createServerHarness()
    running = await attach(harness, { publishRuntimeFile: false })

    expect(await readControlPlaneFile(runtimeDirOfHarness(harness))).toBeUndefined()
    const response = await fetch(`${running.url}/api/health`)
    expect(response.status).toBe(200)
  })

  it('o endereco anunciado e o mesmo que `url` informa ao humano', async () => {
    harness = await createServerHarness()
    running = await attach(harness)

    expect(running.runtimeFile).toBe(join(runtimeDirOfHarness(harness), 'control-plane.json'))
    expect(running.runtime?.url).toBe(running.url)
    expect(running.address.port).toBe(running.runtime?.port)
  })
})
