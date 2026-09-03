import type { MissionSummaryDto } from '@agentic/schemas'
import { MISSION_VIEW_STATES, ProjectHomeDtoSchema } from '@agentic/schemas'
import { describe, expect, it } from 'vitest'
import {
  COMPLETED_RUN,
  MISSING_PROVIDER,
  MISSIONS,
  makeEmptyProjectHome,
  makeIdleProjectHome,
  makeProjectHome,
  READY_PROVIDER,
  RUNNING_RUN,
  UNKNOWN_PROVIDER,
} from '../__fixtures__/home.js'
import {
  ACTIVE_RUN_STATUSES,
  activeRunOf,
  environmentOf,
  missionActionOf,
  missionStateStyle,
} from './home.js'

function missionOf(patch: Partial<MissionSummaryDto>): MissionSummaryDto {
  return {
    id: 'DA-BPM-021',
    file: '.agentic/missions/DA-BPM-021.mission.yaml',
    title: 'Refinar painel',
    state: 'PLANNED',
    tasks: 4,
    phases: 2,
    errors: 0,
    warnings: 0,
    ...patch,
  }
}

describe('fixture do Project Home', () => {
  it('a fixture obedece ao contrato de @agentic/schemas', () => {
    expect(() => ProjectHomeDtoSchema.parse(makeProjectHome())).not.toThrow()
    expect(() => ProjectHomeDtoSchema.parse(makeEmptyProjectHome())).not.toThrow()
    expect(() => ProjectHomeDtoSchema.parse(makeIdleProjectHome())).not.toThrow()
  })
})

describe('execucao que assume a tela', () => {
  it('run ativo e o mais recente que ainda esta em jogo', () => {
    expect(activeRunOf([COMPLETED_RUN, RUNNING_RUN])?.id).toBe(RUNNING_RUN.id)
  })

  it('PAUSED, BLOCKED e VERIFYING continuam sendo execucao ativa', () => {
    for (const status of ACTIVE_RUN_STATUSES) {
      expect(activeRunOf([{ ...COMPLETED_RUN, status }])?.id).toBe(COMPLETED_RUN.id)
    }
  })

  it('run encerrado nao sequestra a Home', () => {
    const home = makeIdleProjectHome()
    expect(home.runs.length).toBeGreaterThan(0)
    expect(activeRunOf(home.runs)).toBeUndefined()
  })

  it('rascunho nao e execucao ativa: ninguem esta executando nada ainda', () => {
    expect(activeRunOf([{ ...COMPLETED_RUN, status: 'DRAFT' }])).toBeUndefined()
    expect(activeRunOf([{ ...COMPLETED_RUN, status: 'APPROVED' }])).toBeUndefined()
  })
})

describe('acao coerente com o estado da missao', () => {
  it('missao que nao compila nao ganha botao — ganha motivo', () => {
    const action = missionActionOf(missionOf({ state: 'INVALID', errors: 2 }))
    expect(action.kind).toBe('none')
    expect(action.label).toBe('')
    expect(action.hint).toContain('não compila')
  })

  it('estado terminal sem run registrado nao oferece abrir execucao', () => {
    for (const state of ['COMPLETED', 'FAILED', 'CANCELLED', 'RUNNING'] as const) {
      const action = missionActionOf(missionOf({ state }))
      expect(action.kind, `${state} ofereceu abrir um run que nao existe`).toBe('none')
      expect(action.runId).toBeUndefined()
    }
  })

  it('missao sem id nao oferece abrir a missao', () => {
    const action = missionActionOf(missionOf({ id: undefined, state: 'PLANNED' }))
    expect(action.kind).toBe('none')
    expect(action.hint).toContain('id de missão')
  })

  it('em execucao a acao leva ao run, nao a tela de partida', () => {
    const action = missionActionOf(missionOf({ state: 'RUNNING', lastRun: RUNNING_RUN }))
    expect(action.kind).toBe('open-run')
    expect(action.runId).toBe(RUNNING_RUN.id)
    expect(action.missionId).toBeUndefined()
  })

  it('rascunho e missao aprovada levam a missao, com rotulos diferentes', () => {
    const draft = missionActionOf(missionOf({ state: 'DRAFT' }))
    const approved = missionActionOf(missionOf({ state: 'APPROVED' }))
    expect(draft.kind).toBe('open-mission')
    expect(approved.kind).toBe('open-mission')
    expect(draft.missionId).toBe('DA-BPM-021')
    expect(draft.label).not.toBe(approved.label)
  })

  it('toda acao oferecida tem alvo, e toda ausencia de acao tem motivo', () => {
    for (const mission of MISSIONS) {
      const action = missionActionOf(mission)
      if (action.kind === 'open-run') expect(action.runId).toBeDefined()
      if (action.kind === 'open-mission') expect(action.missionId).toBeDefined()
      if (action.kind === 'none') expect(action.label).toBe('')
      expect(action.hint.length).toBeGreaterThan(0)
    }
  })
})

describe('cor nunca e o unico diferenciador', () => {
  it('cada estado de missao tem icone e rotulo distintos', () => {
    const icons = new Set(MISSION_VIEW_STATES.map((state) => missionStateStyle(state).icon))
    const labels = new Set(MISSION_VIEW_STATES.map((state) => missionStateStyle(state).label))
    expect(icons.size).toBe(MISSION_VIEW_STATES.length)
    expect(labels.size).toBe(MISSION_VIEW_STATES.length)
  })
})

describe('saude do ambiente', () => {
  it('prontidao nao apurada nunca e pintada como pronta', () => {
    const summary = environmentOf([READY_PROVIDER, UNKNOWN_PROVIDER])
    expect(summary.verdict).toBe('INDETERMINATE')
    expect(summary.byState.UNKNOWN + summary.byState.INSTALLED).toBe(1)
  })

  it('fornecedor instalado sem sonda de sessao tambem nao vira pronto', () => {
    const installed = { ...READY_PROVIDER, ready: 'unknown' as const }
    expect(environmentOf([installed]).verdict).toBe('INDETERMINATE')
  })

  it('falha observada vence indeterminacao', () => {
    const summary = environmentOf([UNKNOWN_PROVIDER, MISSING_PROVIDER])
    expect(summary.verdict).toBe('ATTENTION')
    expect(summary.detail).toContain('1 de 2')
  })

  it('pronto so quando todo fornecedor foi observado pronto', () => {
    expect(environmentOf([READY_PROVIDER]).verdict).toBe('READY')
  })

  it('projeto sem fornecedor e dito com todas as letras, nao como ambiente pronto', () => {
    const summary = environmentOf([])
    expect(summary.verdict).toBe('NONE')
    expect(summary.detail).toContain('nenhum fornecedor')
  })
})
