import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireControlPlaneOwnership } from '@agentic/persistence'
import { afterEach, describe, expect, it } from 'vitest'
import { createServerHarness, type ServerHarness } from './__fixtures__/harness.js'
import { readControlPlaneFile } from './control-plane-file.js'
import { ControlPlaneBusyError } from './ownership.js'
import { type BootedControlPlane, createControlPlaneService, ServiceStateError } from './service.js'

/**
 * A maquina de estados do SERVICO (STABILITY-SLICE-004).
 *
 * E o que a extensao do editor vai chamar: `start`, `stop`, `restart`, `status`. Cada
 * propriedade abaixo e uma que o Stop/Restart de uma janela precisa poder assumir — e
 * quase todas sao sobre NAO fazer algo: nao criar segundo dono, nao devolver a posse com
 * efeito vivo, nao explodir num `stop` repetido.
 */

const harnesses: ServerHarness[] = []
const services: ReturnType<typeof createControlPlaneService>[] = []
const extras: string[] = []

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop().catch(() => undefined)
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  for (const dir of extras.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Projeto pronto e SEM dono: quem vai ser dono aqui e o servico sob teste. */
async function projeto(): Promise<ServerHarness> {
  const criado = await createServerHarness()
  criado.lease.release()
  harnesses.push(criado)
  return criado
}

function servico(root: string, deps?: Parameters<typeof createControlPlaneService>[1]) {
  const created = createControlPlaneService({ repoRoot: root, port: 0, webDist: root }, deps)
  services.push(created)
  return created
}

const runtimeDir = (root: string): string => join(root, '.agentic')

function posseLivre(root: string): boolean {
  const outcome = acquireControlPlaneOwnership({ baseDir: runtimeDir(root) })
  if (outcome.ok) outcome.lease.release()
  return outcome.ok
}

describe('ControlPlaneService', () => {
  it('nasce STOPPED e start() leva a RUNNING com endereco, identidade e adocao', async () => {
    const p = await projeto()
    const s = servico(p.root)
    expect(s.status()).toMatchObject({ status: 'STOPPED' })

    const snap = await s.start()
    expect(snap).toMatchObject({
      status: 'RUNNING',
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
    })
    expect(snap.instanceId).toBeTypeOf('string')
    expect(snap.adoption).toEqual({ adopted: [], refused: [] })
    expect(s.status().status).toBe('RUNNING')
    // A descoberta aponta para ESTA instancia.
    expect((await readControlPlaneFile(runtimeDir(p.root)))?.instanceId).toBe(snap.instanceId)
    expect(posseLivre(p.root)).toBe(false)
  })

  it('start() e idempotente: duas chamadas, um dono, a mesma identidade', async () => {
    const p = await projeto()
    const s = servico(p.root)
    const primeiro = await s.start()
    const segundo = await s.start()
    expect(segundo.instanceId).toBe(primeiro.instanceId)
    expect(segundo.status).toBe('RUNNING')
  })

  it('duas chamadas CONCORRENTES de start() compartilham a mesma partida', async () => {
    const p = await projeto()
    const s = servico(p.root)
    const [a, b] = await Promise.all([s.start(), s.start()])
    expect(a.instanceId).toBe(b.instanceId)
    expect(s.status().status).toBe('RUNNING')
  })

  it('stop() devolve a posse, retira a descoberta e leva a STOPPED', async () => {
    const p = await projeto()
    const s = servico(p.root)
    await s.start()
    const snap = await s.stop()
    expect(snap.status).toBe('STOPPED')
    expect(snap.url).toBeUndefined()
    expect(await readControlPlaneFile(runtimeDir(p.root))).toBeUndefined()
    expect(posseLivre(p.root)).toBe(true)
  })

  it('stop() em STOPPED e previsivel: devolve o estado, sem erro', async () => {
    const p = await projeto()
    const s = servico(p.root)
    expect((await s.stop()).status).toBe('STOPPED')
    await s.start()
    await s.stop()
    expect((await s.stop()).status).toBe('STOPPED')
  })

  it('dois stop() concorrentes compartilham o mesmo encerramento', async () => {
    const p = await projeto()
    const s = servico(p.root)
    await s.start()
    const [a, b] = await Promise.all([s.stop(), s.stop()])
    expect([a.status, b.status]).toEqual(['STOPPED', 'STOPPED'])
    expect(posseLivre(p.root)).toBe(true)
  })

  it('restart() devolve a posse de fato e sobe um dono NOVO', async () => {
    const p = await projeto()
    const s = servico(p.root)
    const antes = await s.start()
    const depois = await s.restart()
    expect(depois.status).toBe('RUNNING')
    expect(depois.instanceId).not.toBe(antes.instanceId)
    expect((await readControlPlaneFile(runtimeDir(p.root)))?.instanceId).toBe(depois.instanceId)
    expect(posseLivre(p.root)).toBe(false)
  })

  it('start() num projeto que OUTRO possui e recusado com o dono no motivo, e fica STOPPED', async () => {
    const p = await projeto()
    const dono = servico(p.root)
    const primeiro = await dono.start()
    const outro = servico(p.root)
    await expect(outro.start()).rejects.toBeInstanceOf(ControlPlaneBusyError)
    const snap = outro.status()
    expect(snap.status).toBe('STOPPED')
    expect(snap.failure?.code).toBe('OWNERSHIP_ALREADY_HELD')
    expect(snap.owner?.instanceId).toBe(primeiro.instanceId)
    // O dono legitimo nao foi afetado.
    expect(dono.status().status).toBe('RUNNING')
  })

  it('projetos diferentes tem servicos independentes', async () => {
    const a = await projeto()
    const b = await projeto()
    const sa = servico(a.root)
    const sb = servico(b.root)
    const [ra, rb] = await Promise.all([sa.start(), sb.start()])
    expect(ra.instanceId).not.toBe(rb.instanceId)
    await sa.stop()
    expect(sb.status().status).toBe('RUNNING')
    expect(posseLivre(a.root)).toBe(true)
    expect(posseLivre(b.root)).toBe(false)
  })

  it('stop() que nao consegue parar os efeitos fica FAILED e NAO devolve a posse', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'agentic-service-')))
    extras.push(dir)
    const posse = acquireControlPlaneOwnership({ baseDir: runtimeDir(dir) })
    if (!posse.ok) throw new Error('fixture: posse recusada')
    let tentativas = 0
    // Um control plane de mentira cujo encerramento falha uma vez (efeito que nao parou) e
    // devolve a posse so na segunda: e o contrato de `RunningServer.close` sob timeout.
    const booted: BootedControlPlane = {
      url: 'http://127.0.0.1:1',
      lease: { instanceId: posse.lease.instanceId },
      close: async (): Promise<void> => {
        tentativas += 1
        if (tentativas === 1) throw new Error('orquestrador nao encerrou dentro do prazo')
        posse.lease.release()
      },
    }
    const s = servico(dir, { boot: () => Promise.resolve(booted) })
    await s.start()

    await expect(s.stop()).rejects.toThrow('nao encerrou')
    expect(s.status()).toMatchObject({ status: 'FAILED', failure: { at: 'stop' } })
    // Posse retida: outro processo NAO consegue assumir.
    expect(posseLivre(dir)).toBe(false)
    // start() recusa enquanto o encerramento nao terminar.
    await expect(s.start()).rejects.toBeInstanceOf(ServiceStateError)

    // O stop seguinte tenta de novo — e desta vez devolve o projeto.
    expect((await s.stop()).status).toBe('STOPPED')
    expect(posseLivre(dir)).toBe(true)
    expect(tentativas).toBe(2)
  })

  it('status() nunca muta: consultar durante STARTING e STOPPING so observa', async () => {
    const p = await projeto()
    const s = servico(p.root)
    const starting = s.start()
    expect(s.status().status).toBe('STARTING')
    await starting
    const stopping = s.stop()
    expect(s.status().status).toBe('STOPPING')
    await stopping
    expect(s.status().status).toBe('STOPPED')
  })
})
