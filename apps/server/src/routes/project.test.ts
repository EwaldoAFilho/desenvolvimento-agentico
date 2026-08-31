import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MissionSummaryDto, ProjectHomeDto } from '@agentic/schemas'
import { ProjectHomeDtoSchema } from '@agentic/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { CLEAN_MISSION, ERROR_MISSION, WARNING_MISSION } from '../__fixtures__/files.js'
import { ACTOR, createServerHarness, type ServerHarness } from '../__fixtures__/harness.js'

let harness: ServerHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

const ALL = { missions: [CLEAN_MISSION, WARNING_MISSION, ERROR_MISSION] }

async function home(current: ServerHarness): Promise<ProjectHomeDto> {
  const response = await current.app.inject({ method: 'GET', url: '/api/project' })
  expect(response.statusCode).toBe(200)
  return ProjectHomeDtoSchema.parse(response.json())
}

function missionOf(body: ProjectHomeDto, id: string): MissionSummaryDto {
  const found = body.missions.find((mission) => mission.id === id)
  if (found === undefined) throw new Error(`missao ${id} nao esta na Home`)
  return found
}

function missionsDirOf(current: ServerHarness): string {
  return join(current.root, '.agentic', 'missions')
}

describe('GET /api/project', () => {
  it('responde identidade e ambiente sem nenhum run criado', async () => {
    harness = await createServerHarness(ALL)
    const body = await home(harness)

    expect(body.project.name).toBe('orquestrador-teste')
    expect(body.project.configured).toBe(true)
    expect(body.project.missionsDir).toBe('.agentic/missions')
    expect(body.project.defaultProvider).toBe('mock')
    expect(body.project.gates).toContain('unit')
    expect(body.project.providers.map((provider) => provider.providerId)).toContain('mock')
    expect(body.runs).toEqual([])
    expect(body.missions.length).toBe(3)
  })

  it('responde mesmo sem diretorio de missoes: projeto novo nao e falha', async () => {
    harness = await createServerHarness(ALL)
    await rm(missionsDirOf(harness), { recursive: true, force: true })
    const body = await home(harness)
    expect(body.missions).toEqual([])
    expect(body.project.name).toBe('orquestrador-teste')
  })

  it('nenhum caminho absoluto do host atravessa para o cliente', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({ method: 'GET', url: '/api/project' })
    expect(response.body).not.toContain(harness.root)
    for (const mission of ProjectHomeDtoSchema.parse(response.json()).missions) {
      expect(mission.file.startsWith('/')).toBe(false)
      expect(mission.file).toMatch(/^\.agentic\/missions\//)
    }
  })

  it('missao sem run aparece como PLANNED, com titulo e contagem', async () => {
    harness = await createServerHarness(ALL)
    const mission = missionOf(await home(harness), 'DA-SRV-001')

    expect(mission.state).toBe('PLANNED')
    expect(mission.title).toBe('missao de teste do servidor')
    expect(mission.tasks).toBe(2)
    expect(mission.phases).toBe(1)
    expect(mission.errors).toBe(0)
    expect(mission.lastRun).toBeUndefined()
  })

  it('missao com ERROR e listada como INVALID, com os erros contados', async () => {
    harness = await createServerHarness(ALL)
    const mission = missionOf(await home(harness), 'DA-SRV-003')

    expect(mission.state).toBe('INVALID')
    expect(mission.errors).toBeGreaterThan(0)
    // Titulo vazio: o arquivo nao compila e nao se inventa titulo para missao quebrada.
    expect(mission.title).toBe('')
  })

  it('missao com WARNING compila e conta o aviso', async () => {
    harness = await createServerHarness(ALL)
    const mission = missionOf(await home(harness), 'DA-SRV-002')

    expect(mission.state).toBe('PLANNED')
    expect(mission.warnings).toBe(1)
    expect(mission.errors).toBe(0)
  })

  it('missao com run traz estado, ultimo run e contadores apurados', async () => {
    harness = await createServerHarness(ALL)
    const approved = await harness.app.inject({
      method: 'POST',
      url: '/api/missions/approve',
      payload: { file: harness.missionFile('DA-SRV-001'), actor: ACTOR },
    })
    expect(approved.statusCode).toBe(200)
    const runId = approved.json<{ runId: string }>().runId

    const body = await home(harness)
    const mission = missionOf(body, 'DA-SRV-001')
    expect(mission.state).toBe('APPROVED')
    expect(mission.lastRun?.id).toBe(runId)
    expect(mission.lastRun?.status).toBe('APPROVED')
    expect(mission.lastRun?.counters?.PENDING).toBe(2)
    expect(mission.lastRun?.startedAt).toBeUndefined()

    expect(body.runs.map((run) => run.id)).toEqual([runId])
    // Missao sem run nenhum continua sem ultimo run: nada e emprestado de outra missao.
    expect(missionOf(body, 'DA-SRV-002').lastRun).toBeUndefined()
  })

  it('a Home enxerga o rascunho antes de qualquer aprovacao', async () => {
    harness = await createServerHarness(ALL)
    await harness.app.inject({
      method: 'POST',
      url: '/api/missions/draft',
      payload: { file: harness.missionFile('DA-SRV-001') },
    })

    const mission = missionOf(await home(harness), 'DA-SRV-001')
    expect(mission.state).toBe('DRAFT')
    expect(mission.lastRun?.status).toBe('DRAFT')
  })

  it('`limit` corta a lista de execucoes sem apagar o ultimo run da missao', async () => {
    harness = await createServerHarness(ALL)
    for (const id of ['DA-SRV-001', 'DA-SRV-002']) {
      await harness.app.inject({
        method: 'POST',
        url: '/api/missions/draft',
        payload: { file: harness.missionFile(id) },
      })
    }

    const response = await harness.app.inject({ method: 'GET', url: '/api/project?limit=1' })
    const body = ProjectHomeDtoSchema.parse(response.json())
    expect(body.runs.length).toBe(1)
    expect(missionOf(body, 'DA-SRV-001').lastRun).toBeDefined()
    expect(missionOf(body, 'DA-SRV-002').lastRun).toBeDefined()
  })

  it('`limit` invalido e recusado com codigo', async () => {
    harness = await createServerHarness(ALL)
    const response = await harness.app.inject({ method: 'GET', url: '/api/project?limit=-3' })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_QUERY')
  })

  it('diretorio de missoes ilegivel vira erro com codigo, nao lista vazia', async () => {
    harness = await createServerHarness(ALL)
    const dir = missionsDirOf(harness)
    // Substituir o diretorio por um arquivo reproduz "existe e nao da para listar" sem
    // depender de permissao — root ignoraria um chmod.
    await rm(dir, { recursive: true, force: true })
    await writeFile(dir, 'nao sou um diretorio\n', 'utf8')

    const response = await harness.app.inject({ method: 'GET', url: '/api/project' })
    expect(response.statusCode).toBe(500)
    const error = response.json<{ error: { code: string; message: string } }>().error
    expect(error.code).toBe('MISSIONS_DIR_UNREADABLE')
    expect(error.message).not.toContain(harness.root)
  })

  it('missao ilegivel vira erro com codigo, nao item omitido em silencio', async () => {
    harness = await createServerHarness(ALL)
    // Entrada que se parece com missao e nao pode ser lida como arquivo.
    await mkdir(join(missionsDirOf(harness), 'quebrada.yaml'), { recursive: true })

    const response = await harness.app.inject({ method: 'GET', url: '/api/project' })
    expect(response.statusCode).toBe(500)
    const error = response.json<{ error: { code: string; message: string } }>().error
    expect(error.code).toBe('MISSION_FILE_UNREADABLE')
    expect(error.message).toContain('.agentic/missions/quebrada.yaml')
    expect(error.message).not.toContain(harness.root)
  })
})
