import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RUN, seededRun } from './__fixtures__/builders.js'
import { acquireControlPlaneOwnership, type ControlPlaneLease } from './control-plane-lock.js'
import { openPersistence, type Persistence } from './persistence.js'

/**
 * STABILITY-SLICE-004 — escrita de artefato JA iniciada quando a posse e devolvida.
 *
 * 003C fechou a escrita que COMECA sem posse: `writable` e perguntado antes de qualquer
 * efeito. O que ficou aberto e a escrita que comecou COM posse: depois da guarda ha dois
 * `await` (`mkdir`, `writeFile`), e um `release()` no meio nao cancela nada — a
 * continuacao ainda grava o arquivo, agora possivelmente no diretorio de um projeto que
 * outro processo ja possui, e so entao falha no banco fechado.
 *
 * A propriedade (I15): enquanto houver escrita em voo, a posse NAO e devolvida. Quem
 * chama `release()` recebe `false`, o lock do arquivo continua na mao, e a escrita termina
 * inteira — arquivo E linha. So depois disso o projeto passa adiante.
 */

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let root: string | undefined
let lease: ControlPlaneLease | undefined
let persistence: Persistence | undefined

afterEach(async () => {
  persistence?.close()
  persistence = undefined
  lease?.release()
  lease = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('artefato em voo segura a posse (I15)', () => {
  it('release() com escrita iniciada devolve false e o lock continua com o dono', async () => {
    root = await mkdtemp(join(tmpdir(), 'agentic-inflight-'))
    const baseDir = join(root, '.agentic')
    const posse = acquireControlPlaneOwnership({ baseDir })
    if (!posse.ok) throw new Error(`fixture: posse recusada (${posse.detail})`)
    lease = posse.lease

    const entrou = deferred()
    const segue = deferred()
    persistence = openPersistence({
      baseDir,
      mode: 'readwrite',
      artifacts: {
        writeFile: async (path, data): Promise<void> => {
          entrou.resolve()
          await segue.promise
          await writeFile(path, data)
        },
      },
    })
    const p = persistence
    // A MESMA amarracao de `createControlPlane`: a posse revoga o escritor.
    lease.onRelease(() => p.close())
    await seededRun(p)

    const escrita = p.artifacts.write({
      runId: RUN,
      kind: 'agent-log',
      relativePath: 'attempts/T01-a1/agent.log',
      content: 'linha 1\n',
    })
    await entrou.promise

    // A escrita passou pela guarda e esta entre o `mkdir` e o `writeFile`.
    const devolveu = lease.release()
    const outro = acquireControlPlaneOwnership({ baseDir })
    if (outro.ok) outro.lease.release()

    segue.resolve()
    const resultado = await escrita.then(
      (record) => ({ ok: true as const, path: record.path }),
      (error: unknown) => ({ ok: false as const, error: String(error) }),
    )

    expect({ devolveu, outroConseguiu: outro.ok, resultado }).toEqual({
      // Posse nao passa adiante com efeito em voo.
      devolveu: false,
      outroConseguiu: false,
      // E o efeito que ja tinha comecado termina INTEIRO: arquivo e linha no banco.
      resultado: { ok: true, path: `runs/${RUN}/attempts/T01-a1/agent.log` },
    })

    // Sem nada em voo, a posse e devolvida — e o proximo consegue.
    expect(lease.release()).toBe(true)
    const depois = acquireControlPlaneOwnership({ baseDir })
    expect(depois.ok).toBe(true)
    if (depois.ok) depois.lease.release()
  })

  it('escrita que COMECA depois do release nao toca o disco', async () => {
    root = await mkdtemp(join(tmpdir(), 'agentic-inflight-'))
    const baseDir = join(root, '.agentic')
    const posse = acquireControlPlaneOwnership({ baseDir })
    if (!posse.ok) throw new Error(`fixture: posse recusada (${posse.detail})`)
    lease = posse.lease
    let tocouDisco = false
    persistence = openPersistence({
      baseDir,
      mode: 'readwrite',
      artifacts: {
        mkdir: async (): Promise<void> => {
          tocouDisco = true
        },
        writeFile: async (): Promise<void> => {
          tocouDisco = true
        },
      },
    })
    const p = persistence
    lease.onRelease(() => p.close())
    await seededRun(p)
    const write = p.artifacts.write.bind(p.artifacts)
    expect(lease.release()).toBe(true)

    await expect(
      write({ runId: RUN, kind: 'patch', relativePath: 'attempts/T01-a1/patch.diff', content: 'x' }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' })
    expect(tocouDisco).toBe(false)
  })
})
