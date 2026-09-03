import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireControlPlaneOwnership } from '@agentic/persistence'
import { readControlPlaneFile, removeControlPlaneFile } from '@agentic/server'
import { describe, expect, it } from 'vitest'
import {
  adopters,
  raceForOwnership,
  type SpawnedOwner,
  spawnOwner,
} from './support/cross-process.js'
import { createMissionHarness, type MissionHarness } from './support/harness.js'
import { withScriptedProviders } from './support/providers.js'

/**
 * I14 — para um `repoRoot` canonico existe no maximo UM control plane owner.
 *
 * Este arquivo nasceu vermelho: media D4, o defeito em que dois processos abriam o mesmo
 * `.agentic/state.db`, adotavam o mesmo run e cada um se considerava o unico dono — com
 * worktrees colidindo no mesmo caminho e tentativas descartadas por transicao invalida.
 * Agora ele mede a garantia.
 *
 * Regra de honestidade da suite: nenhuma prova aqui pode se apoiar em porta ocupada. As
 * portas sao EFEMERAS ou explicitamente DIFERENTES. O que precisa ser exclusivo e o projeto,
 * nao o socket — `agentic serve --port N` tem de esbarrar na mesma parede.
 */

/**
 * Projeto descartavel com UM run em `PAUSED` — recuperavel, portanto adotavel no boot, e sem
 * nada em voo. Estado parado deixa a medicao ser sobre POSSE, nao sobre quem correu mais.
 */
async function projetoComRunRecuperavel(): Promise<MissionHarness> {
  const harness = await createMissionHarness({ project: withScriptedProviders })
  await harness.start()
  await harness.plane.pauseRun(harness.runId, { actor: 'diagnostico@D4' })
  const run = await harness.run()
  if (run.status !== 'PAUSED') throw new Error(`fixture: esperava PAUSED, veio ${run.status}`)
  // O processo do teste solta o banco E a posse: o que sobra e um projeto sem dono, com um
  // run parado. Entregar a posse aqui e o ponto — os donos deste teste sao outros processos.
  await harness.plane.close()
  harness.lease.release()
  return harness
}

async function encerrar(owners: readonly SpawnedOwner[]): Promise<void> {
  for (const owner of owners) await owner.stop().catch(() => undefined)
}

function agenticDe(harness: MissionHarness): string {
  return join(harness.root, '.agentic')
}

async function descoberta(
  harness: MissionHarness,
): Promise<Awaited<ReturnType<typeof readControlPlaneFile>>> {
  return readControlPlaneFile(agenticDe(harness))
}

/** Quem virou dono de verdade: reportou posse E adotou o run. */
function donos(owners: readonly SpawnedOwner[], runId: string): SpawnedOwner[] {
  return owners.filter(
    (owner) => owner.report.ok && (owner.report.adopted ?? []).some((e) => e.runId === runId),
  )
}

describe('I14 — no maximo um control plane owner por projeto', () => {
  it('A. dois processos sobre o mesmo projeto: um vira dono, o outro e recusado', async () => {
    const harness = await projetoComRunRecuperavel()
    const owners: SpawnedOwner[] = []
    try {
      owners.push(await spawnOwner(harness.root, { label: 'A' }))
      owners.push(await spawnOwner(harness.root, { label: 'B' }))

      expect(adopters(owners, harness.runId)).toEqual(['A'])

      const perdedor = owners[1]
      expect(perdedor?.report.ok).toBe(false)
      expect(perdedor?.report.code).toBe('OWNERSHIP_ALREADY_HELD')
      // A prova de que o perdedor nao chegou as operacoes mutaveis: ele nao abriu banco.
      // Sem isso, "recusado" seria so uma mensagem depois do estrago.
      expect(perdedor?.report.dbPath).toBeUndefined()
      expect(perdedor?.report.instanceId).toBeUndefined()
      // A recusa aponta o dono vivo: quem chegou depois precisa saber a quem falar.
      expect(perdedor?.report.error).toContain(owners[0]?.report.url ?? '<sem url>')
    } finally {
      await encerrar(owners)
      await harness.cleanup().catch(() => undefined)
    }
  })

  it('B. porta diferente nao compra o direito de possuir o projeto', async () => {
    const harness = await projetoComRunRecuperavel()
    const owners: SpawnedOwner[] = []
    try {
      // Portas explicitas e DIFERENTES: nenhum EADDRINUSE participa desta prova. Se o
      // segundo processo for barrado, foi o projeto que o barrou.
      owners.push(await spawnOwner(harness.root, { label: 'A', port: 45311 }))
      owners.push(await spawnOwner(harness.root, { label: 'B', port: 45312 }))

      expect(owners[0]?.report.url).toBe('http://127.0.0.1:45311')
      expect(adopters(owners, harness.runId)).toEqual(['A'])
      expect(owners[1]?.report.code).toBe('OWNERSHIP_ALREADY_HELD')
    } finally {
      await encerrar(owners)
      await harness.cleanup().catch(() => undefined)
    }
  })

  it('C. partida SIMULTANEA de oito processos: exatamente um vencedor, dez vezes', async () => {
    const harness = await projetoComRunRecuperavel()
    try {
      // A corrida do §10, oito competidores de verdade por rodada. Duas falhas possiveis, e
      // as duas sao graves: dois vencedores (o defeito) e ZERO vencedores (ninguem sobe).
      // A segunda foi medida de fato quando a espera por ocupacao era nula — por isso a
      // primitiva espera um instante curto antes de concluir que ha dono.
      for (let rodada = 1; rodada <= 10; rodada += 1) {
        const resultado = await raceForOwnership(agenticDe(harness), 8)
        expect({ rodada, vencedores: resultado.winners.length }).toEqual({
          rodada,
          vencedores: 1,
        })
        expect(resultado.losers).toHaveLength(7)
        expect(resultado.losers.every((linha) => linha.includes('OWNERSHIP_ALREADY_HELD'))).toBe(
          true,
        )
      }
    } finally {
      await harness.cleanup().catch(() => undefined)
    }
  }, 180_000)

  it('D. SIGINT no dono libera o projeto e retira o registro de descoberta', async () => {
    const harness = await projetoComRunRecuperavel()
    const owners: SpawnedOwner[] = []
    try {
      const primeiro = await spawnOwner(harness.root, { label: 'A' })
      expect((await descoberta(harness))?.instanceId).toBe(primeiro.report.instanceId)

      await primeiro.stop('SIGINT')
      // Encerramento normal: o endereco sai do mapa junto com a posse.
      expect(await descoberta(harness)).toBeUndefined()

      const segundo = await spawnOwner(harness.root, { label: 'B' })
      owners.push(segundo)
      expect(adopters([segundo], harness.runId)).toEqual(['B'])
    } finally {
      await encerrar(owners)
      await harness.cleanup().catch(() => undefined)
    }
  })

  it('E. SIGTERM no dono libera o projeto para o proximo', async () => {
    const harness = await projetoComRunRecuperavel()
    const owners: SpawnedOwner[] = []
    try {
      const primeiro = await spawnOwner(harness.root, { label: 'A' })
      await primeiro.stop('SIGTERM')

      const segundo = await spawnOwner(harness.root, { label: 'B' })
      owners.push(segundo)
      expect(adopters([segundo], harness.runId)).toEqual(['B'])
      expect(segundo.report.instanceId).not.toBe(primeiro.report.instanceId)
    } finally {
      await encerrar(owners)
      await harness.cleanup().catch(() => undefined)
    }
  })

  it('F/G/M/N. dono morto por SIGKILL: posse livre, descoberta velha nao atrapalha', async () => {
    const harness = await projetoComRunRecuperavel()
    const owners: SpawnedOwner[] = []
    try {
      const primeiro = await spawnOwner(harness.root, { label: 'A' })
      const antigo = await descoberta(harness)
      expect(antigo?.instanceId).toBe(primeiro.report.instanceId)

      // SIGKILL: nenhum handler roda, nada e liberado pelo processo. Um lock que dependesse
      // de encerramento gracioso deixaria o projeto inutilizavel a partir daqui (§21).
      await primeiro.kill()
      // A descoberta continua no disco, apontando para um processo que ja nao existe.
      expect((await descoberta(harness))?.instanceId).toBe(primeiro.report.instanceId)

      // G: registro stale nao impede o novo dono — quem decide e o lock, nao o arquivo.
      const segundo = await spawnOwner(harness.root, { label: 'B' })
      owners.push(segundo)
      expect(adopters([segundo], harness.runId)).toEqual(['B'])

      // M: a descoberta passa a apontar para o dono ATUAL, com a identidade dele.
      const atual = await descoberta(harness)
      expect(atual?.instanceId).toBe(segundo.report.instanceId)
      expect(atual?.instanceId).not.toBe(primeiro.report.instanceId)
      expect(atual?.url).toBe(segundo.report.url)

      // N: o encerramento tardio do processo ANTIGO nao pode apagar o registro do novo.
      const removeu = await removeControlPlaneFile(agenticDe(harness), {
        instanceId: primeiro.report.instanceId ?? 'sem-identidade',
      })
      expect(removeu).toBe(false)
      expect((await descoberta(harness))?.instanceId).toBe(segundo.report.instanceId)
    } finally {
      await encerrar(owners)
      await harness.cleanup().catch(() => undefined)
    }
  })

  it('H/K/L. so o vencedor adota; o perdedor nao produz efeito nenhum', async () => {
    const harness = await projetoComRunRecuperavel()
    const owners: SpawnedOwner[] = []
    try {
      // Nascem juntos, sem nenhum esperar o outro reportar.
      const dupla = await Promise.all([
        spawnOwner(harness.root, { label: 'A' }),
        spawnOwner(harness.root, { label: 'B' }),
      ])
      owners.push(...dupla)

      const vencedores = donos(dupla, harness.runId)
      expect(vencedores).toHaveLength(1)
      const perdedores = dupla.filter((owner) => !owner.report.ok)
      expect(perdedores).toHaveLength(1)

      // L: o perdedor nao abriu banco, nao ganhou identidade e nao adotou nada.
      for (const perdedor of perdedores) {
        expect(perdedor.report.dbPath).toBeUndefined()
        expect(perdedor.report.adopted).toBeUndefined()
        expect(perdedor.report.instanceId).toBeUndefined()
      }

      // H: a autoridade nao e o PID. Os dois processos existem e tem pid valido; o que
      // separa dono de recusado e a posse, e a identidade do dono nao deriva do pid.
      expect(dupla.every((owner) => owner.report.pid > 0)).toBe(true)
      const dono = vencedores[0]
      expect(dono?.report.instanceId).toBeDefined()
      expect(dono?.report.instanceId).not.toBe(String(dono?.report.pid))
      expect((await descoberta(harness))?.instanceId).toBe(dono?.report.instanceId)
    } finally {
      await encerrar(owners)
      await harness.cleanup().catch(() => undefined)
    }
  })

  it('I. projetos DIFERENTES continuam podendo ter um dono cada', async () => {
    const um = await projetoComRunRecuperavel()
    const outro = await projetoComRunRecuperavel()
    const owners: SpawnedOwner[] = []
    try {
      owners.push(await spawnOwner(um.root, { label: 'A' }))
      owners.push(await spawnOwner(outro.root, { label: 'B' }))

      // A garantia e POR projeto. Um lock global (porta fixa, arquivo em ~/) faria este caso
      // falhar — e trabalhar em dois projetos ao mesmo tempo e uso normal.
      expect(adopters(owners, um.runId)).toEqual(['A'])
      expect(adopters(owners, outro.runId)).toEqual(['B'])
    } finally {
      await encerrar(owners)
      await um.cleanup().catch(() => undefined)
      await outro.cleanup().catch(() => undefined)
    }
  })

  it('J. link simbolico para o mesmo projeto NAO cria um segundo dono', async () => {
    const harness = await projetoComRunRecuperavel()
    const owners: SpawnedOwner[] = []
    let atalhoDir: string | undefined
    try {
      owners.push(await spawnOwner(harness.root, { label: 'A' }))
      expect(adopters(owners, harness.runId)).toEqual(['A'])

      atalhoDir = await realpath(await mkdtemp(join(tmpdir(), 'agentic-link-')))
      const atalho = join(atalhoDir, 'projeto')
      await symlink(harness.root, atalho, 'dir')

      // Mesmo projeto, caminho com outro texto. Comparar caminho cru daria dois donos.
      const pelaLink = await spawnOwner(atalho, { label: 'B' })
      owners.push(pelaLink)
      expect(pelaLink.report.code).toBe('OWNERSHIP_ALREADY_HELD')
      expect(pelaLink.report.dbPath).toBeUndefined()
      expect(adopters(owners, harness.runId)).toEqual(['A'])
    } finally {
      await encerrar(owners)
      if (atalhoDir !== undefined) await rm(atalhoDir, { recursive: true, force: true })
      await harness.cleanup().catch(() => undefined)
    }
  })

  it('a descoberta nunca e lida como posse: registro apagado nao solta o projeto', async () => {
    const harness = await projetoComRunRecuperavel()
    const owners: SpawnedOwner[] = []
    try {
      const dono = await spawnOwner(harness.root, { label: 'A' })
      owners.push(dono)

      // Alguem apaga `control-plane.json` — limpeza manual, ferramenta, script. O endereco
      // some do mapa; a POSSE nao, porque ela nunca esteve nesse arquivo.
      await rm(join(agenticDe(harness), 'control-plane.json'), { force: true })
      expect(await descoberta(harness)).toBeUndefined()

      const outcome = acquireControlPlaneOwnership({ baseDir: agenticDe(harness) })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('inalcancavel')
      expect(outcome.code).toBe('OWNERSHIP_ALREADY_HELD')

      // E o registro tambem nao pode ser JSON pela metade: a escrita e temporario + rename.
      const bruto = await readFile(join(agenticDe(harness), 'control-plane.json'), 'utf8').catch(
        () => undefined,
      )
      if (bruto !== undefined) expect(() => JSON.parse(bruto)).not.toThrow()
    } finally {
      await encerrar(owners)
      await harness.cleanup().catch(() => undefined)
    }
  })
})
