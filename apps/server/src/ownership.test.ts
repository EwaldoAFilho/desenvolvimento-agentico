import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireControlPlaneOwnership } from '@agentic/persistence'
import { afterEach, describe, expect, it } from 'vitest'
import { createServerHarness, type ServerHarness } from './__fixtures__/harness.js'
import { readControlPlaneFile } from './control-plane-file.js'
import { ControlPlaneBusyError, shutdownControlPlane } from './ownership.js'
import { type RunningServer, startServer } from './server.js'

/**
 * I14 no boot do servidor.
 *
 * O que importa aqui nao e so "o segundo e recusado": e QUANDO ele e recusado. Uma recusa
 * depois de abrir o banco ja teria migrado, ja teria ligado WAL e ja poderia ter adotado —
 * o estrago de D4 acontece antes de qualquer mensagem chegar ao humano.
 */

let harness: ServerHarness | undefined
const abertos: RunningServer[] = []

afterEach(async () => {
  for (const server of abertos.splice(0)) await server.close().catch(() => undefined)
  await harness?.cleanup()
  harness = undefined
})

/**
 * Projeto pronto e SEM dono.
 *
 * O harness e dono do que cria (um plane sem posse nao muta, I14), mas neste arquivo quem
 * precisa ser dono e o `startServer` sob teste. Devolver a posse aqui, a vista, e o que
 * deixa a medicao ser sobre o boot do servidor e nao sobre o fixture.
 */
async function projetoSemDono(): Promise<ServerHarness> {
  const criado = await createServerHarness()
  criado.lease.release()
  return criado
}

async function subir(extra: { readonly port?: number } = {}): Promise<RunningServer> {
  if (harness === undefined) throw new Error('harness ausente')
  const server = await startServer({
    repoRoot: harness.root,
    port: extra.port ?? 0,
    webDist: harness.root,
  })
  abertos.push(server)
  return server
}

/** Ocupa uma porta de verdade para fazer o `listen` falhar DEPOIS da posse ser adquirida. */
function portaOcupada(): Promise<{ readonly port: number; close: () => Promise<void> }> {
  const socket = createTcpServer()
  return new Promise((done, fail) => {
    socket.once('error', fail)
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address()
      if (address === null || typeof address === 'string') return fail(new Error('sem porta'))
      done({
        port: address.port,
        close: () =>
          new Promise<void>((fechado) => {
            socket.close(() => fechado())
          }),
      })
    })
  })
}

describe('posse do projeto no boot do control plane', () => {
  it('o segundo control plane e recusado com o endereco do dono no motivo', async () => {
    harness = await projetoSemDono()
    const dono = await subir()

    const recusa = await subir().then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(recusa).toBeInstanceOf(ControlPlaneBusyError)
    expect((recusa as ControlPlaneBusyError).code).toBe('OWNERSHIP_ALREADY_HELD')
    expect((recusa as ControlPlaneBusyError).message).toContain(dono.url)
    expect((recusa as ControlPlaneBusyError).owner?.instanceId).toBe(dono.lease?.instanceId)
  })

  it('a posse e adquirida ANTES de abrir o banco: o perdedor nao chega a criar plane', async () => {
    harness = await projetoSemDono()
    await subir()

    // Se o perdedor tivesse aberto banco, o erro seria outro (ou nenhum) e sobraria uma
    // conexao `readwrite` a mais no mesmo `state.db` — exatamente o que D4 media.
    await expect(subir()).rejects.toBeInstanceOf(ControlPlaneBusyError)
  })

  it('a descoberta publicada carrega o instanceId do dono', async () => {
    harness = await projetoSemDono()
    const dono = await subir()

    const registro = await readControlPlaneFile(`${harness.root}/.agentic`)
    expect(registro?.instanceId).toBe(dono.lease?.instanceId)
    expect(registro?.url).toBe(dono.url)
    expect(dono.plane.instanceId).toBe(dono.lease?.instanceId)
  })

  it('encerrar devolve a posse: o proximo control plane sobe', async () => {
    harness = await projetoSemDono()
    const primeiro = await subir()
    expect(primeiro.lease?.held).toBe(true)
    await primeiro.close()
    expect(primeiro.lease?.held).toBe(false)
    // O registro de descoberta sai junto — era dele.
    expect(await readControlPlaneFile(`${harness.root}/.agentic`)).toBeUndefined()

    const segundo = await subir()
    expect(segundo.lease?.held).toBe(true)
    expect(segundo.lease?.instanceId).not.toBe(primeiro.lease?.instanceId)
  })

  it('a chave nao e escolhida pelo chamador: caminho alternativo esbarra na mesma parede', async () => {
    harness = await projetoSemDono()
    const dono = await subir()

    /**
     * O mesmo projeto, alcancado por outro TEXTO de caminho — um link simbolico.
     *
     * Enquanto `startServer` aceitava um diretorio de estado do chamador, duas chamadas para
     * o mesmo `repoRoot` podiam disputar locks diferentes e vencer as duas (I14). Agora nao
     * ha opcao: a chave sai de `projectIdentityOf`, e o segundo boot esbarra no primeiro.
     */
    const atalhoDir = await realpath(await mkdtemp(join(tmpdir(), 'agentic-alias-')))
    try {
      const atalho = join(atalhoDir, 'projeto')
      await symlink(harness.root, atalho, 'dir')
      const recusa = await startServer({ repoRoot: atalho, port: 0, webDist: atalho }).then(
        (aberto) => {
          abertos.push(aberto)
          return undefined
        },
        (error: unknown) => error,
      )
      expect(recusa).toBeInstanceOf(ControlPlaneBusyError)
      expect((recusa as ControlPlaneBusyError).owner?.instanceId).toBe(dono.lease?.instanceId)
    } finally {
      await rm(atalhoDir, { recursive: true, force: true })
    }
  })

  it('boot que falha DEPOIS da posse a devolve, em vez de trancar o projeto', async () => {
    harness = await projetoSemDono()
    const ocupada = await portaOcupada()
    try {
      // A porta ja esta tomada: a posse e adquirida e o `listen` quebra logo depois. Um
      // processo que sobreviva a essa falha — uma suite, um supervisor, o editor — nao pode
      // sair carregando a posse de um projeto que ele nao esta servindo.
      await expect(subir({ port: ocupada.port })).rejects.toThrow()
    } finally {
      await ocupada.close()
    }

    const outcome = acquireControlPlaneOwnership({ baseDir: `${harness.root}/.agentic` })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) outcome.lease.release()

    // E o caminho normal volta a funcionar no mesmo processo.
    const depois = await subir()
    expect(depois.lease?.held).toBe(true)
  })
})

describe('ordem do encerramento', () => {
  interface Passos {
    readonly ordem: string[]
    readonly steps: Parameters<typeof shutdownControlPlane>[0]
    solta: boolean
  }

  function passos(
    falhas: { readonly servidor?: Error; readonly efeitos?: Error; readonly posse?: boolean } = {},
  ): Passos {
    const ordem: string[] = []
    const registro: Passos = {
      ordem,
      solta: false,
      steps: {
        stopServing: async (): Promise<void> => {
          ordem.push('servidor')
          if (falhas.servidor !== undefined) throw falhas.servidor
        },
        stopEffects: async (): Promise<void> => {
          ordem.push('efeitos')
          if (falhas.efeitos !== undefined) throw falhas.efeitos
        },
        releaseOwnership: (): boolean => {
          ordem.push('posse')
          if (falhas.posse === true) return false
          registro.solta = true
          return true
        },
      },
    }
    return registro
  }

  it('para de atender, para os efeitos e SO ENTAO devolve o projeto', async () => {
    const p = passos()
    await shutdownControlPlane(p.steps)
    expect(p.ordem).toEqual(['servidor', 'efeitos', 'posse'])
  })

  it('servidor que nao fecha nao impede os efeitos de parar, e a falha nao vira silencio', async () => {
    const p = passos({ servidor: new Error('socket preso') })
    await expect(shutdownControlPlane(p.steps)).rejects.toThrow('socket preso')
    // Os orquestradores pararam mesmo assim, e o projeto foi devolvido.
    expect(p.ordem).toEqual(['servidor', 'efeitos', 'posse'])
    expect(p.solta).toBe(true)
  })

  it('soltar que NAO solta e falha, nunca silencio: o chamador sabe que continua dono', async () => {
    const p = passos({ posse: true })
    await expect(shutdownControlPlane(p.steps)).rejects.toMatchObject({
      code: 'OWNERSHIP_RETAINED',
    })
    expect(p.ordem).toEqual(['servidor', 'efeitos', 'posse'])
    expect(p.solta).toBe(false)
  })

  it('o prazo do encerramento chega aos efeitos', async () => {
    let recebido: unknown
    await shutdownControlPlane(
      {
        stopServing: async (): Promise<void> => undefined,
        stopEffects: async (options): Promise<void> => {
          recebido = options
        },
        releaseOwnership: () => true,
      },
      { graceMs: 1234 },
    )
    expect(recebido).toEqual({ graceMs: 1234 })
  })

  it('efeitos que NAO param seguram a posse: o projeto nao passa adiante com loop vivo', async () => {
    const p = passos({ efeitos: new Error('orquestrador nao abandonou') })
    await expect(shutdownControlPlane(p.steps)).rejects.toThrow('orquestrador nao abandonou')
    // Devolver aqui deixaria outro processo assumir enquanto este ainda despacha — que e
    // exatamente o dano de D4 voltando por um caminho de falha.
    expect(p.solta).toBe(false)
    expect(p.ordem).toEqual(['servidor', 'efeitos'])
  })
})
