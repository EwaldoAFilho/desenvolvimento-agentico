import { RUN_STATUSES } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import {
  MISSION_VIEW_STATES,
  type MissionSummaryDto,
  MissionSummaryDtoSchema,
  type MissionViewState,
  missionStateOf,
  type ProjectHomeDto,
  ProjectHomeDtoSchema,
  RunSummaryDtoSchema,
} from './project.js'

const run = {
  id: '01J8ZC0X0000000000000000AA',
  missionId: 'DA-EXEMPLO-002',
  status: 'RUNNING',
  createdAt: '2026-08-31T10:00:00.000Z',
  startedAt: '2026-08-31T10:05:00.000Z',
} as const

const mission: MissionSummaryDto = {
  id: 'DA-EXEMPLO-002',
  file: '.agentic/missions/DA-EXEMPLO-002.mission.yaml',
  title: 'Relatorio de estoque',
  state: 'PLANNED',
  tasks: 4,
  phases: 2,
  errors: 0,
  warnings: 1,
}

const home: ProjectHomeDto = {
  project: {
    name: 'estoque-cli',
    configured: true,
    missionsDir: '.agentic/missions/',
    defaultProvider: 'agente-a',
    gates: ['unit'],
    providers: [
      {
        providerId: 'agente-a',
        installed: true,
        ready: 'unknown',
        version: '1.2.3',
        detail: 'CLI nao expoe estado de autenticacao',
        running: 0,
        capacity: 2,
      },
    ],
    planners: [
      {
        providerId: 'agente-a',
        simulated: false,
        acceptsRevision: true,
        reportsUsage: false,
        state: 'INSTALLED',
      },
    ],
  },
  missions: [mission],
  runs: [run],
}

describe('a Home nao recebe caminho absoluto do host', () => {
  it('o payload completo e aceito com caminhos relativos', () => {
    expect(ProjectHomeDtoSchema.safeParse(home).success).toBe(true)
  })

  it('caminho absoluto de missao e recusado pelo contrato', () => {
    const vazando = { ...mission, file: '/home/alguem/projeto/.agentic/missions/M.yaml' }
    expect(MissionSummaryDtoSchema.safeParse(vazando).success).toBe(false)
  })

  it('caminho que sobe da raiz tambem e recusado', () => {
    const subindo = { ...mission, file: '../outro-projeto/missao.yaml' }
    expect(MissionSummaryDtoSchema.safeParse(subindo).success).toBe(false)
  })
})

describe('a Home responde sem nenhum run criado', () => {
  it('projeto sem missao e sem run e um payload valido, nao um erro', () => {
    const vazio: ProjectHomeDto = {
      project: { ...home.project, gates: [], providers: [], planners: [] },
      missions: [],
      runs: [],
    }

    expect(ProjectHomeDtoSchema.safeParse(vazio).success).toBe(true)
  })

  it('projeto nao configurado e estado declarado, nao ausencia de resposta', () => {
    const naoConfigurado: ProjectHomeDto = {
      project: { ...home.project, configured: false, gates: [], providers: [], planners: [] },
      missions: [],
      runs: [],
    }

    expect(ProjectHomeDtoSchema.safeParse(naoConfigurado).success).toBe(true)
  })

  it('missao que nao compila continua listada, sem id e sem titulo inventados', () => {
    const quebrada = {
      file: '.agentic/missions/quebrada.yaml',
      title: '',
      state: 'INVALID',
      tasks: 0,
      phases: 0,
      errors: 3,
      warnings: 0,
    }

    expect(MissionSummaryDtoSchema.safeParse(quebrada).success).toBe(true)
  })
})

describe('missionStateOf — estado derivado de fato, nunca declarado', () => {
  it('sem run e compilando: PLANNED', () => {
    expect(missionStateOf({ compiles: true })).toBe('PLANNED')
  })

  it('sem run e sem compilar: INVALID', () => {
    expect(missionStateOf({ compiles: false })).toBe('INVALID')
  })

  it('rascunho aguardando ato humano: DRAFT', () => {
    expect(missionStateOf({ compiles: true, lastRunStatus: 'DRAFT' })).toBe('DRAFT')
  })

  it('aprovada e ainda nao iniciada: APPROVED', () => {
    expect(missionStateOf({ compiles: true, lastRunStatus: 'APPROVED' })).toBe('APPROVED')
  })

  it.each(['RUNNING', 'PAUSED', 'BLOCKED', 'VERIFYING'] as const)(
    'run em %s aparece como RUNNING: ha execucao para acompanhar',
    (status) => {
      expect(missionStateOf({ compiles: true, lastRunStatus: status })).toBe('RUNNING')
    },
  )

  it('execucao viva ganha do YAML quebrado: o grafo do run foi congelado na partida', () => {
    expect(missionStateOf({ compiles: false, lastRunStatus: 'RUNNING' })).toBe('RUNNING')
  })

  it('editar o YAML depois de terminar volta a valer: run terminal nao protege arquivo', () => {
    expect(missionStateOf({ compiles: false, lastRunStatus: 'COMPLETED' })).toBe('INVALID')
  })

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'] as const)('run terminal em %s', (status) => {
    expect(missionStateOf({ compiles: true, lastRunStatus: status })).toBe(status)
  })

  it('todo estado de run tem destino: nenhum cai fora do catalogo', () => {
    for (const status of RUN_STATUSES) {
      const state = missionStateOf({ compiles: true, lastRunStatus: status })
      expect(MISSION_VIEW_STATES).toContain(state as MissionViewState)
    }
  })
})

describe('RunSummaryDto', () => {
  it('contadores sao opcionais: nao apurado nao vira uma linha de zeros', () => {
    const parsed = RunSummaryDtoSchema.safeParse(run)

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.counters).toBeUndefined()
  })

  it('estado desconhecido de run e recusado', () => {
    expect(RunSummaryDtoSchema.safeParse({ ...run, status: 'QUASE_LA' }).success).toBe(false)
  })
})
