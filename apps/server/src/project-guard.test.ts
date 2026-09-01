import { acquireControlPlaneOwnership } from '@agentic/persistence'
import { afterEach, describe, expect, it } from 'vitest'
import { createServerHarness, type ServerHarness } from './__fixtures__/harness.js'
import { PROJECT_HEADER, PROJECT_MISMATCH } from './project-identity.js'

/**
 * A outra metade de I14 no lado HTTP: o comando prova a QUEM ele se destinava.
 *
 * A CLI ja recusa um endereco que responde por outro repositorio — mas essa recusa vem de
 * uma sonda ANTERIOR ao comando. Entre sondar e mandar, o dono pode encerrar e outro control
 * plane, de outro projeto, reaproveitar a porta: o comando chegaria a um servidor legitimo e
 * mutaria o run errado. Aqui quem decide e o servidor, sobre o projeto que ele possui.
 */

let harness: ServerHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

describe('o servidor confere o projeto declarado na requisicao', () => {
  it('comando endereçado a OUTRO projeto e recusado, sem tocar no estado', async () => {
    harness = await createServerHarness()
    const antes = harness.plane.persistence.queries.listRuns({ limit: 50 }).length

    const resposta = await harness.app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { [PROJECT_HEADER]: '/projetos/de-outra-pessoa' },
      payload: { missionPath: harness.missionFile('DA-SRV-001'), actor: 'humano' },
    })

    expect(resposta.statusCode).toBe(409)
    expect(resposta.json()).toMatchObject({ error: { code: PROJECT_MISMATCH } })
    expect(harness.plane.persistence.queries.listRuns({ limit: 50 })).toHaveLength(antes)
  })

  it('o handler NAO chega a rodar: a aprovacao endereçada errado nao acontece', async () => {
    harness = await createServerHarness()
    const recusada = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/DA-SRV-001/approve',
      headers: { [PROJECT_HEADER]: '/projetos/de-outra-pessoa' },
      payload: { actor: 'humano' },
    })
    expect(recusada.statusCode).toBe(409)
    expect(harness.plane.persistence.queries.listRuns({ limit: 50 })).toHaveLength(0)

    // A MESMA chamada, endereçada certo, cria o run: a recusa acima foi do enderecamento,
    // nao de a rota estar quebrada.
    const aceita = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/DA-SRV-001/approve',
      headers: { [PROJECT_HEADER]: harness.root },
      payload: { actor: 'humano' },
    })
    expect(aceita.statusCode).toBeLessThan(300)
    expect(harness.plane.persistence.queries.listRuns({ limit: 50 })).toHaveLength(1)
  })

  it('leitura tambem e recusada: o projeto errado nao vira resposta plausivel', async () => {
    harness = await createServerHarness()
    const resposta = await harness.app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { [PROJECT_HEADER]: '/projetos/de-outra-pessoa' },
    })
    expect(resposta.statusCode).toBe(409)
  })

  it('o projeto CERTO passa, inclusive por um caminho equivalente', async () => {
    harness = await createServerHarness()
    // Mesmo projeto, outro texto de caminho: a comparacao e por caminho real, como a posse.
    const equivalente = `${harness.root}/./`
    const resposta = await harness.app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { [PROJECT_HEADER]: equivalente },
    })
    expect(resposta.statusCode).toBe(200)
  })

  it('sem cabecalho, passa: quem nao declara e o dashboard servido por este mesmo dono', async () => {
    harness = await createServerHarness()
    const resposta = await harness.app.inject({ method: 'GET', url: '/api/health' })
    expect(resposta.statusCode).toBe(200)
    // E a guarda nao inventou posse: ela confere endereçamento, nao substitui o lease.
    const outra = acquireControlPlaneOwnership({ baseDir: `${harness.root}/.agentic` })
    expect(outra.ok).toBe(false)
  })
})
