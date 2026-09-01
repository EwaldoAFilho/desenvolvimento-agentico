import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adopters, type SpawnedOwner, spawnOwner } from './support/cross-process.js'
import { createMissionHarness, type MissionHarness } from './support/harness.js'

/**
 * D4 — SINGLE CONTROL PLANE OWNERSHIP.
 *
 * VERMELHO DE PROPOSITO. Estes testes descrevem a garantia que o produto ainda NAO tem:
 * para um `repoRoot`, no maximo UM control plane pode possuir orquestradores e produzir
 * efeitos. Hoje dois processos abrem o mesmo `.agentic/state.db`, adotam o mesmo run no boot
 * (STABILITY-SLICE-002) e cada um se considera o unico dono.
 *
 * Regra de honestidade da suite (§17): nenhuma prova aqui pode se apoiar em porta ocupada.
 * As portas sao EFEMERAS (`0`) ou explicitamente DIFERENTES. O que precisa ser exclusivo e o
 * projeto, nao o socket — `agentic serve --port N` tem de esbarrar na mesma parede.
 *
 * Os cinco casos nao estao todos vermelhos: C e E ja passam e existem como guarda. Uma
 * correcao que feche A, B e D quebrando C ou E trocou um defeito por outro pior — um lock
 * que nunca se solta depois de uma queda, ou um lock global que impede trabalhar em dois
 * projetos ao mesmo tempo.
 */

/** Fornecedores in-process no `project.yaml` do fixture: nenhuma CLI real, zero quota. */
function comAgentesInProcess(projectText: string): string {
  const inicio = projectText.indexOf('  default: claude-code')
  const fim = projectText.indexOf('\ngates:')
  if (inicio === -1 || fim === -1) throw new Error('fixture: bloco de providers nao encontrado')
  const bloco = [
    '  default: alfa',
    '  registry:',
    '    alfa:',
    '      kind: inprocess',
    '      maxConcurrent: 3',
    '      roles: [executor, reviewer]',
    '    beta:',
    '      kind: inprocess',
    '      maxConcurrent: 2',
    '      roles: [executor, reviewer]',
    '',
  ].join('\n')
  return projectText.slice(0, inicio) + bloco + projectText.slice(fim)
}

/**
 * Projeto descartavel com UM run em `PAUSED` — recuperavel, portanto adotavel no boot, e
 * sem nada em voo. Estado parado deixa a medicao ser sobre POSSE, nao sobre quem correu mais.
 */
async function projetoComRunRecuperavel(): Promise<MissionHarness> {
  const harness = await createMissionHarness({ project: comAgentesInProcess })
  await harness.start()
  await harness.plane.pauseRun(harness.runId, { actor: 'diagnostico@D4' })
  const run = await harness.run()
  if (run.status !== 'PAUSED') throw new Error(`fixture: esperava PAUSED, veio ${run.status}`)
  // O processo do teste solta o banco: o que sobra e um run parado esperando um dono.
  await harness.plane.close()
  return harness
}

async function encerrar(owners: readonly SpawnedOwner[]): Promise<void> {
  for (const owner of owners) await owner.stop().catch(() => undefined)
}

async function registroDeDescoberta(repoRoot: string): Promise<{ pid?: number; port?: number }> {
  const texto = await readFile(join(repoRoot, '.agentic', 'control-plane.json'), 'utf8').catch(
    () => '{}',
  )
  try {
    return JSON.parse(texto) as { pid?: number; port?: number }
  } catch {
    return {}
  }
}

describe('D4 — no maximo um control plane por repoRoot', () => {
  it('A. dois processos sobre o mesmo projeto: um vira dono, o outro nao', async () => {
    const harness = await projetoComRunRecuperavel()
    const owners: SpawnedOwner[] = []
    try {
      owners.push(await spawnOwner(harness.root, { label: 'A' }))
      owners.push(await spawnOwner(harness.root, { label: 'B' }))

      // Os dois processos existem e falam com o MESMO banco: e essa a situacao real de
      // duas janelas do editor abertas no mesmo repositorio.
      const bancos = new Set(owners.map((owner) => owner.report.dbPath).filter(Boolean))
      expect(bancos.size).toBeLessThanOrEqual(1)

      // HOJE: ['A', 'B'] — dois donos do mesmo run, cada um com seu loop.
      expect(adopters(owners, harness.runId)).toEqual(['A'])
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
      // segundo processo for barrado, foi o `repoRoot` que o barrou.
      owners.push(await spawnOwner(harness.root, { label: 'A', port: 45311 }))
      owners.push(await spawnOwner(harness.root, { label: 'B', port: 45312 }))

      expect(owners[0]?.report.url).not.toBe(owners[1]?.report.url)
      // HOJE: ['A', 'B'] — a defesa atual e a colisao de porta, e ela nao se aplica aqui.
      expect(adopters(owners, harness.runId)).toEqual(['A'])
    } finally {
      await encerrar(owners)
      await harness.cleanup().catch(() => undefined)
    }
  })

  it('C. dono morto ABRUPTAMENTE nao tranca o projeto para sempre', async () => {
    const harness = await projetoComRunRecuperavel()
    const owners: SpawnedOwner[] = []
    try {
      const primeiro = await spawnOwner(harness.root, { label: 'A' })
      expect(adopters([primeiro], harness.runId)).toEqual(['A'])
      // SIGKILL: nenhum handler roda, nada e liberado. Um lock que dependesse de
      // encerramento gracioso deixaria o projeto inutilizavel a partir daqui (§21).
      await primeiro.kill()

      const segundo = await spawnOwner(harness.root, { label: 'B' })
      owners.push(segundo)
      expect(adopters([segundo], harness.runId)).toEqual(['B'])
    } finally {
      await encerrar(owners)
      await harness.cleanup().catch(() => undefined)
    }
  })

  it('D. partida SIMULTANEA: exatamente um vencedor', async () => {
    const harness = await projetoComRunRecuperavel()
    let owners: SpawnedOwner[] = []
    try {
      // Nascem juntos: nenhum dos dois espera o outro reportar. E a corrida do §10 — os
      // dois olham "ha dono?", nenhum ve, e os dois tentam assumir.
      owners = await Promise.all([
        spawnOwner(harness.root, { label: 'A' }),
        spawnOwner(harness.root, { label: 'B' }),
      ])

      // HOJE: ['A', 'B'] — a janela entre olhar e assumir nao e fechada por nada.
      expect(adopters(owners, harness.runId)).toEqual([expect.any(String)])

      // E a descoberta tem de apontar para o dono, nao para quem gravou por ultimo: hoje
      // `control-plane.json` e sobrescrito e um dos donos vivos some do mapa.
      const registro = await registroDeDescoberta(harness.root)
      const donos = owners.filter((owner) =>
        (owner.report.adopted ?? []).some((entry) => entry.runId === harness.runId),
      )
      expect(registro.pid).toBe(donos[0]?.report.pid)
    } finally {
      await encerrar(owners)
      await harness.cleanup().catch(() => undefined)
    }
  })

  it('E. projetos DIFERENTES continuam podendo ter um dono cada', async () => {
    const um = await projetoComRunRecuperavel()
    const outro = await projetoComRunRecuperavel()
    const owners: SpawnedOwner[] = []
    try {
      owners.push(await spawnOwner(um.root, { label: 'A' }))
      owners.push(await spawnOwner(outro.root, { label: 'B' }))

      // A garantia e POR repoRoot. Um lock global (uma porta fixa, um arquivo em ~/) faria
      // este caso falhar — e trabalhar em dois projetos ao mesmo tempo e uso normal.
      expect(adopters(owners, um.runId)).toEqual(['A'])
      expect(adopters(owners, outro.runId)).toEqual(['B'])
    } finally {
      await encerrar(owners)
      await um.cleanup().catch(() => undefined)
      await outro.cleanup().catch(() => undefined)
    }
  })
})
