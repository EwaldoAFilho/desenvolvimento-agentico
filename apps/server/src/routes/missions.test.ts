import type { RunId } from '@agentic/domain'
import { CompileReportDtoSchema } from '@agentic/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { CLEAN_MISSION, ERROR_MISSION, WARNING_MISSION } from '../__fixtures__/files.js'
import { ACTOR, createServerHarness, type ServerHarness } from '../__fixtures__/harness.js'

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
