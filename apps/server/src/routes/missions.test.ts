import type { RunId } from '@agentic/domain'
import type { CreateDraftResultDto } from '@agentic/schemas'
import {
  CompileReportDtoSchema,
  CreateDraftResultDtoSchema,
  MissionSummaryDtoSchema,
} from '@agentic/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { CLEAN_MISSION, ERROR_MISSION, WARNING_MISSION } from '../__fixtures__/files.js'
import { ACTOR, createServerHarness, type ServerHarness } from '../__fixtures__/harness.js'
import { serializedByPlan } from './missions.js'

let harness: ServerHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

const ALL = { missions: [CLEAN_MISSION, WARNING_MISSION, ERROR_MISSION] }

describe('compilacao da missao', () => {
  it('lista as missoes do repositorio', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({ method: 'GET', url: '/api/missions' })
    expect(response.statusCode).toBe(200)
    const files = response.json<{ file: string }[]>().map((item) => item.file)
    expect(files).toContain('.agentic/missions/DA-SRV-001.mission.yaml')
    expect(files.length).toBe(3)
  })

  it('a listagem nao expoe o caminho absoluto do host', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({ method: 'GET', url: '/api/missions' })
    expect(response.body).not.toContain(harness.root)
  })

  it('cada missao listada traz id, titulo, estado, contagem de tasks e ultimo run', async () => {
    harness = await createServerHarness(ALL)
    const approved = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/approve',
      payload: { file: harness.missionFile('DA-SRV-001'), actor: ACTOR },
    })
    const runId = approved.json<{ runId: string }>().runId

    const response = await harness.app.inject({ method: 'GET', url: '/api/missions' })
    const missions = response.json<unknown[]>().map((item) => MissionSummaryDtoSchema.parse(item))

    const clean = missions.find((mission) => mission.id === 'DA-SRV-001')
    expect(clean?.title).toBe('missao de teste do servidor')
    expect(clean?.state).toBe('APPROVED')
    expect(clean?.tasks).toBe(2)
    expect(clean?.lastRun?.id).toBe(runId)

    const broken = missions.find((mission) => mission.id === 'DA-SRV-003')
    expect(broken?.state).toBe('INVALID')
    expect(broken?.errors).toBeGreaterThan(0)
    expect(broken?.lastRun).toBeUndefined()
  })

  it('GET /api/missions/:file/compile devolve CompileReportDto', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/missions/DA-SRV-001/compile',
    })
    expect(response.statusCode).toBe(200)
    const report = CompileReportDtoSchema.parse(response.json())
    expect(report.missionId).toBe('DA-SRV-001')
    expect(report.ok).toBe(true)
    expect(report.stats.tasks).toBe(2)
    expect(report.diagnostics.some((item) => item.severity === 'ERROR')).toBe(false)
  })

  it('POST /api/missions/compile aceita o caminho do arquivo', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/compile',
      payload: { file: harness.missionFile('DA-SRV-002') },
    })
    const report = CompileReportDtoSchema.parse(response.json())
    expect(report.missionId).toBe('DA-SRV-002')
    expect(report.stats.warnings).toBe(1)
  })

  it('missao com ERROR compila com ok:false e a lista de diagnosticos', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/missions/compile?file=DA-SRV-003',
    })
    const report = CompileReportDtoSchema.parse(response.json())
    expect(report.ok).toBe(false)
    expect(report.diagnostics.map((item) => item.code)).toContain('DA1003')
  })

  it('missao inexistente responde 404', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/missions/DA-NAO-999/compile',
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('MISSION_NOT_FOUND')
  })

  it('referencia que sai do repositorio e recusada', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/compile',
      payload: { file: '../../etc/passwd' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('MISSION_REF_INVALID')
  })
})

describe('POST /api/missions/draft', () => {
  it('cria o run em DRAFT sem aprovar e sem registrar ato humano', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/draft',
      payload: { missionPath: harness.missionFile('DA-SRV-001') },
    })
    expect(response.statusCode).toBe(201)
    const body = CreateDraftResultDtoSchema.parse(response.json())
    expect(body.run.status).toBe('DRAFT')
    expect(body.alreadyExisted).toBe(false)
    expect(body.report.missionId).toBe('DA-SRV-001')

    const events = await harness.plane.persistence.events.list(body.run.id as RunId)
    expect(events.some((event) => event.type === 'human.mission_approved')).toBe(false)
    expect(body.run.timestamps.approvedAt).toBeUndefined()
  })

  it('o DAG do rascunho pode ser lido sem nenhuma aprovacao', async () => {
    harness = await createServerHarness(ALL)
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/draft',
      payload: { missionId: 'DA-SRV-001' },
    })
    const runId = CreateDraftResultDtoSchema.parse(created.json()).run.id

    const snapshot = await harness.app.inject({ method: 'GET', url: `/api/runs/${runId}/snapshot` })
    expect(snapshot.statusCode).toBe(200)
    const graph = snapshot.json<{ graph: { nodes: { id: string }[]; edges: unknown[] } }>().graph
    expect(graph.nodes.map((node) => node.id)).toEqual(['T01', 'T02'])
    expect(graph.edges.length).toBe(1)
  })

  /**
   * A idempotencia sequencial nao prova nada sobre corrida: `findRun` seguido de `createRun`
   * deixava dois pedidos simultaneos passarem ambos pela consulta antes de qualquer um
   * gravar. Clique duplo no navegador e exatamente isso.
   */
  it('dois pedidos SIMULTANEOS do mesmo plano criam um rascunho so', async () => {
    harness = await createServerHarness(ALL)
    const payload = { file: harness.missionFile('DA-SRV-001') }

    const [a, b] = await Promise.all([
      harness.app.inject({ method: 'POST', url: '/api/missions/draft', payload }),
      harness.app.inject({ method: 'POST', url: '/api/missions/draft', payload }),
    ])

    const primeiro = CreateDraftResultDtoSchema.parse(a.json())
    const segundo = CreateDraftResultDtoSchema.parse(b.json())
    expect(primeiro.run.id).toBe(segundo.run.id)
    // Exatamente um dos dois pode ter criado; o outro tem que ter reaproveitado.
    expect([primeiro.alreadyExisted, segundo.alreadyExisted].filter(Boolean)).toHaveLength(1)

    const runs = await harness.plane.persistence.queries.listRuns({})
    const doPlano = runs.filter((run) => run.mission_id === 'DA-SRV-001')
    expect(doPlano).toHaveLength(1)
  })

  it('rascunho da mesma versao do plano nao duplica run', async () => {
    harness = await createServerHarness(ALL)
    const payload = { file: harness.missionFile('DA-SRV-001') }
    const first = await harness.app.inject({ method: 'POST', url: '/api/missions/draft', payload })
    const second = await harness.app.inject({ method: 'POST', url: '/api/missions/draft', payload })

    expect(second.statusCode).toBe(200)
    const before = first.json<CreateDraftResultDto>()
    const after = second.json<CreateDraftResultDto>()
    expect(after.run.id).toBe(before.run.id)
    expect(after.alreadyExisted).toBe(true)
    const runs = await harness.app.inject({ method: 'GET', url: '/api/runs' })
    expect(runs.json<unknown[]>().length).toBe(1)
  })

  it('o rascunho ja aprovado e devolvido em vez de um segundo run do mesmo spec', async () => {
    harness = await createServerHarness(ALL)
    const payload = { file: harness.missionFile('DA-SRV-001') }
    const approved = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/approve',
      payload: { ...payload, actor: ACTOR },
    })
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/draft',
      payload,
    })

    const body = CreateDraftResultDtoSchema.parse(response.json())
    expect(body.alreadyExisted).toBe(true)
    expect(body.run.id).toBe(approved.json<{ runId: string }>().runId)
    expect(body.run.status).toBe('APPROVED')
    const runs = await harness.app.inject({ method: 'GET', url: '/api/runs' })
    expect(runs.json<unknown[]>().length).toBe(1)
  })

  it('aprovar depois do rascunho aproveita o run que ja existe', async () => {
    harness = await createServerHarness(ALL)
    const payload = { file: harness.missionFile('DA-SRV-001') }
    const draft = await harness.app.inject({ method: 'POST', url: '/api/missions/draft', payload })
    const approved = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/approve',
      payload: { ...payload, actor: ACTOR },
    })

    expect(approved.json<{ runId: string }>().runId).toBe(
      CreateDraftResultDtoSchema.parse(draft.json()).run.id,
    )
    const runs = await harness.app.inject({ method: 'GET', url: '/api/runs' })
    expect(runs.json<unknown[]>().length).toBe(1)
  })

  it('missao com ERROR nao vira rascunho e a resposta traz a lista', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/draft',
      payload: { file: harness.missionFile('DA-SRV-003') },
    })
    expect(response.statusCode).toBe(400)
    const error = response.json<{ error: { code: string; diagnostics: { code: string }[] } }>()
      .error
    expect(error.code).toBe('MISSION_HAS_ERRORS')
    expect(error.diagnostics.map((item) => item.code)).toContain('DA1003')
  })

  it('missao inexistente responde 404 com codigo', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/draft',
      payload: { file: 'DA-NAO-999' },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('MISSION_NOT_FOUND')
  })

  it('sem referencia de missao recusa com codigo', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/draft',
      payload: {},
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('MISSION_REF_REQUIRED')
  })

  it('a rota com o id na URL dispensa corpo', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/DA-SRV-002/draft',
    })
    expect(response.statusCode).toBe(201)
    const body = CreateDraftResultDtoSchema.parse(response.json())
    expect(body.run.missionId).toBe('DA-SRV-002')
    expect(body.run.status).toBe('DRAFT')
  })
})

describe('POST /api/missions/approve', () => {
  it('grava `human.mission_approved` com o actor informado', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/approve',
      payload: { file: harness.missionFile('DA-SRV-001'), actor: ACTOR, note: 'revisado' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<{
      runId: string
      run: { status: string }
      alreadyApproved: boolean
    }>()
    expect(body.run.status).toBe('APPROVED')
    expect(body.alreadyApproved).toBe(false)

    const events = await harness.plane.persistence.events.list(body.runId as RunId)
    const approval = events.find((event) => event.type === 'human.mission_approved')
    expect(approval).toBeDefined()
    expect(approval?.actor).toEqual({ kind: 'human', id: ACTOR })
    expect((approval?.payload as { actor?: string } | undefined)?.actor).toBe(ACTOR)
  })

  it('sem `actor` recusa: nao existe aprovacao automatica', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/approve',
      payload: { file: harness.missionFile('DA-SRV-001') },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('APPROVAL_REQUIRES_ACTOR')
  })

  it('`actor` em branco tambem recusa', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/approve',
      payload: { file: harness.missionFile('DA-SRV-001'), actor: '   ' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('missao com ERROR nao e aprovavel e a resposta traz a lista', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/approve',
      payload: { file: harness.missionFile('DA-SRV-003'), actor: ACTOR },
    })
    expect(response.statusCode).toBe(400)
    const error = response.json<{ error: { code: string; diagnostics: { code: string }[] } }>()
      .error
    expect(error.code).toBe('MISSION_HAS_ERRORS')
    expect(error.diagnostics.map((item) => item.code)).toContain('DA1003')
  })

  it('aprovar o mesmo spec duas vezes nao gera um segundo run', async () => {
    harness = await createServerHarness(ALL)
    const payload = { file: harness.missionFile('DA-SRV-001'), actor: ACTOR }
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/approve',
      payload,
    })
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/approve',
      payload,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json<{ runId: string }>().runId).toBe(first.json<{ runId: string }>().runId)
    expect(second.json<{ alreadyApproved: boolean }>().alreadyApproved).toBe(true)
    const runs = await harness.app.inject({ method: 'GET', url: '/api/runs' })
    expect(runs.json<unknown[]>().length).toBe(1)
  })

  it('a rota com o id na URL aceita o corpo apenas com o actor', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/DA-SRV-002/approve',
      payload: { actor: ACTOR },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ run: { missionId: string } }>().run.missionId).toBe('DA-SRV-002')
  })
})

/**
 * O teste de dois `inject` simultaneos acima NAO reproduz a corrida: os dois pedidos nao
 * chegam a interleavar na janela entre consultar e criar. Entao o que da para provar de
 * verdade e o mecanismo: sem serializacao, duas secoes criticas do mesmo plano se sobrepoem.
 */
describe('serializedByPlan', () => {
  it('nao deixa duas secoes criticas do mesmo plano se sobreporem', async () => {
    let dentro = 0
    let sobreposicoes = 0
    const critica = async (): Promise<void> => {
      dentro += 1
      if (dentro > 1) sobreposicoes += 1
      await new Promise((done) => setTimeout(done, 5))
      dentro -= 1
    }

    await Promise.all([
      serializedByPlan('DA-001@abc', critica),
      serializedByPlan('DA-001@abc', critica),
      serializedByPlan('DA-001@abc', critica),
    ])

    expect(sobreposicoes).toBe(0)
  })

  it('planos diferentes nao esperam um pelo outro', async () => {
    const ordem: string[] = []
    await Promise.all([
      serializedByPlan('A@1', async () => {
        await new Promise((done) => setTimeout(done, 20))
        ordem.push('lento')
      }),
      serializedByPlan('B@1', async () => {
        ordem.push('rapido')
      }),
    ])
    expect(ordem).toEqual(['rapido', 'lento'])
  })

  it('falha de um pedido nao envenena o proximo do mesmo plano', async () => {
    await expect(serializedByPlan('C@1', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    )
    await expect(serializedByPlan('C@1', () => Promise.resolve('ok'))).resolves.toBe('ok')
  })
})

/**
 * Aprovar e ato humano SOBRE UM PLANO. O endpoint recompila o arquivo, entao sem declarar
 * qual plano foi inspecionado a aprovacao ficaria registrada — com o nome de quem aprovou —
 * sobre um plano que essa pessoa nunca viu.
 */
describe('aprovacao declara o plano inspecionado', () => {
  it('recusa quando o specHash inspecionado nao e mais o do arquivo', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/approve',
      payload: {
        missionId: 'DA-SRV-001',
        actor: ACTOR,
        specHash: 'fnv1a64:plano-que-nao-existe-mais',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('MISSION_CHANGED')
  })

  it('aprova quando o specHash bate com o do arquivo', async () => {
    harness = await createServerHarness(ALL)
    const compilado = await harness.app.inject({
      method: 'GET',
      url: '/api/missions/DA-SRV-001/compile',
    })
    const specHash = compilado.json<{ specHash?: string }>().specHash

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/approve',
      payload: { missionId: 'DA-SRV-001', actor: ACTOR, specHash },
    })

    expect(response.statusCode).toBe(200)
  })

  it('comando SEM specHash continua aceito: e o caminho da CLI', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/approve',
      payload: { missionId: 'DA-SRV-001', actor: ACTOR },
    })

    expect(response.statusCode).toBe(200)
  })
})
