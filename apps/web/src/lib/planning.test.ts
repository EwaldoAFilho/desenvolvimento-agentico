import type { PlannerDto, ProviderState } from '@agentic/schemas'
import { PlanningFailureCodeSchema, PROVIDER_STATES } from '@agentic/schemas'
import { describe, expect, it } from 'vitest'
import {
  BROKEN_PLANNER,
  makePlanFailure,
  REAL_PLANNER,
  SECOND_PLANNER,
  SIMULATED_PLANNER,
} from '../__fixtures__/planning.js'
import {
  canPlanWith,
  defaultPlannerOf,
  plannerOptionLabel,
  plannerStateStyle,
  planningDiagnosisOf,
  revisionsText,
  subscriptionNoticeOf,
  usesSubscription,
} from './planning.js'

function withState(planner: PlannerDto, state: ProviderState): PlannerDto {
  return { ...planner, state }
}

describe('quem planeja por padrão', () => {
  it('com um só planejador ele é o padrão — não há o que escolher', () => {
    expect(defaultPlannerOf([SIMULATED_PLANNER])).toBe(SIMULATED_PLANNER)
    expect(defaultPlannerOf([REAL_PLANNER])).toBe(REAL_PLANNER)
  })

  it('sem planejador nenhum não há padrão para inventar', () => {
    expect(defaultPlannerOf([])).toBeUndefined()
  })

  it('o simulado nunca é o padrão enquanto existir um real', () => {
    expect(defaultPlannerOf([SIMULATED_PLANNER, REAL_PLANNER])).toBe(REAL_PLANNER)
  })

  it('entre reais, o observado pronto ganha de quem não teve prontidão apurada', () => {
    expect(defaultPlannerOf([REAL_PLANNER, SECOND_PLANNER])).toBe(SECOND_PLANNER)
  })

  it('o fornecedor padrão do projeto vale quando ele também planeja de verdade', () => {
    expect(defaultPlannerOf([REAL_PLANNER, SECOND_PLANNER], REAL_PLANNER.providerId)).toBe(
      REAL_PLANNER,
    )
  })

  it('fornecedor padrão que é simulado não arrasta o padrão para o simulado', () => {
    const escolhido = defaultPlannerOf(
      [SIMULATED_PLANNER, REAL_PLANNER],
      SIMULATED_PLANNER.providerId,
    )
    expect(escolhido).toBe(REAL_PLANNER)
  })

  it('só de simulados, o padrão continua sendo um deles — a tela é que avisa', () => {
    const outro = { ...SIMULATED_PLANNER, providerId: 'mock2' }
    expect(defaultPlannerOf([SIMULATED_PLANNER, outro])).toBe(SIMULATED_PLANNER)
  })
})

describe('prontidão não apurada não é falha', () => {
  it('falha OBSERVADA impede a ação', () => {
    expect(canPlanWith(BROKEN_PLANNER)).toBe(false)
    expect(canPlanWith(withState(REAL_PLANNER, 'NOT_READY'))).toBe(false)
  })

  it('`unknown` e `installed` continuam permitindo pedir o plano', () => {
    expect(canPlanWith(withState(REAL_PLANNER, 'UNKNOWN'))).toBe(true)
    expect(canPlanWith(withState(REAL_PLANNER, 'INSTALLED'))).toBe(true)
    expect(canPlanWith(withState(REAL_PLANNER, 'READY'))).toBe(true)
  })

  it('cada estado tem ícone e frase própria — cor nunca é o único diferenciador', () => {
    const labels = new Set(PROVIDER_STATES.map((state) => plannerStateStyle(state).label))
    expect(labels.size).toBe(PROVIDER_STATES.length)
    for (const state of PROVIDER_STATES) {
      expect(plannerStateStyle(state).icon.length).toBeGreaterThan(0)
    }
  })
})

describe('aviso de consumo de assinatura', () => {
  it('planejador real consome a assinatura e exige aceite', () => {
    const notice = subscriptionNoticeOf(REAL_PLANNER)
    expect(usesSubscription(REAL_PLANNER)).toBe(true)
    expect(notice.consumes).toBe(true)
    expect(notice.title).toContain(REAL_PLANNER.providerId)
    expect(notice.detail).toContain('Nenhuma chave de API')
  })

  it('planejador simulado não consome nada e diz que não planeja de verdade', () => {
    const notice = subscriptionNoticeOf(SIMULATED_PLANNER)
    expect(usesSubscription(SIMULATED_PLANNER)).toBe(false)
    expect(notice.consumes).toBe(false)
    expect(notice.detail).toContain('não é planejamento de verdade')
  })

  it('o rótulo do simulado diz simulado antes de qualquer coisa sobre ambiente', () => {
    // O simulado da fixture esta `READY`: apresentar o ambiente o faria parecer capaz.
    expect(plannerOptionLabel(SIMULATED_PLANNER)).toContain('simulado, não planeja de verdade')
    expect(plannerOptionLabel(SIMULATED_PLANNER)).not.toContain('observado pronto')
    expect(plannerOptionLabel(SECOND_PLANNER)).toContain('observado pronto')
  })
})

describe('falha de planejamento vira diagnóstico', () => {
  it('todo código do contrato tem título e conserto — nenhum cai em frase genérica', () => {
    const titles = new Set<string>()
    for (const code of PlanningFailureCodeSchema.options) {
      const diagnosis = planningDiagnosisOf(makePlanFailure({ code }))
      expect(diagnosis.title.length).toBeGreaterThan(0)
      expect(diagnosis.hint.length).toBeGreaterThan(0)
      titles.add(diagnosis.title)
    }
    expect(titles.size).toBe(PlanningFailureCodeSchema.options.length)
  })

  it('a contagem de correções se lê', () => {
    expect(revisionsText(0)).toBe('nenhuma correção')
    expect(revisionsText(1)).toBe('1 correção')
    expect(revisionsText(2)).toBe('2 correções')
  })
})
