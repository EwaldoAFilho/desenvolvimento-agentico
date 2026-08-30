import { describe, expect, it } from 'vitest'
import { EXECUTOR, identity } from './__fixtures__/builders.js'
import { UnresolvedReviewPolicyError } from './errors.js'
import { REVIEW_POLICIES, resolveReviewPolicy, selectReviewer } from './review.js'

const PROJECT_POLICY = {
  byRisk: {
    low: 'fresh-session',
    medium: 'cross-provider-preferred',
    high: 'cross-provider-required',
  },
  default: 'fresh-session',
} as const

describe('resolveReviewPolicy — precedencia de 4 niveis', () => {
  it('nivel 1: task.reviewPolicy vence tudo', () => {
    expect(
      resolveReviewPolicy({
        task: { reviewPolicy: 'fresh-session', risk: 'high' },
        missionDefaults: { reviewPolicy: 'cross-provider-required' },
        projectPolicy: PROJECT_POLICY,
      }),
    ).toEqual({ policy: 'fresh-session', source: 'task' })
  })

  it('nivel 2: mission.defaults vence o mapa de risco', () => {
    expect(
      resolveReviewPolicy({
        task: { risk: 'low' },
        missionDefaults: { reviewPolicy: 'cross-provider-required' },
        projectPolicy: PROJECT_POLICY,
      }),
    ).toEqual({ policy: 'cross-provider-required', source: 'mission-defaults' })
  })

  it('nivel 3: project.byRisk[risk] quando nao ha override mais especifico', () => {
    expect(resolveReviewPolicy({ task: { risk: 'high' }, projectPolicy: PROJECT_POLICY })).toEqual({
      policy: 'cross-provider-required',
      source: 'project-by-risk',
    })
    expect(resolveReviewPolicy({ task: { risk: 'low' }, projectPolicy: PROJECT_POLICY })).toEqual({
      policy: 'fresh-session',
      source: 'project-by-risk',
    })
  })

  it('nivel 4: project.default quando o risco nao esta mapeado', () => {
    expect(
      resolveReviewPolicy({
        task: { risk: 'medium' },
        projectPolicy: { byRisk: { high: 'cross-provider-required' }, default: 'fresh-session' },
      }),
    ).toEqual({ policy: 'fresh-session', source: 'project-default' })
  })

  it('sem nenhum nivel definido, lanca em vez de inventar politica', () => {
    expect(() => resolveReviewPolicy({ task: { risk: 'medium' } })).toThrow(
      UnresolvedReviewPolicyError,
    )
  })

  it('o dominio nao conhece o mapa risco->politica: ele chega como parametro', () => {
    const invertido = { byRisk: { high: 'fresh-session' }, default: 'fresh-session' } as const
    expect(resolveReviewPolicy({ task: { risk: 'high' }, projectPolicy: invertido })).toEqual({
      policy: 'fresh-session',
      source: 'project-by-risk',
    })
  })
})

describe('selectReviewer', () => {
  const mesmoFornecedor = identity('session-r1', 'p-alpha', 'reviewer')
  const outroFornecedor = identity('session-r2', 'p-beta', 'reviewer')

  it.each(REVIEW_POLICIES)('%s nunca escolhe a identidade do executor', (policy) => {
    const selection = selectReviewer([EXECUTOR, outroFornecedor], EXECUTOR, policy)
    expect(selection.ok).toBe(true)
    if (selection.ok) expect(selection.reviewer.sessionRef).not.toBe(EXECUTOR.sessionRef)
  })

  it('fresh-session aceita revisor do mesmo fornecedor com sessao nova', () => {
    const selection = selectReviewer([mesmoFornecedor], EXECUTOR, 'fresh-session')
    expect(selection).toMatchObject({ ok: true, policyOutcome: 'satisfied' })
  })

  it('cross-provider-required escolhe fornecedor diferente', () => {
    const selection = selectReviewer(
      [mesmoFornecedor, outroFornecedor],
      EXECUTOR,
      'cross-provider-required',
    )
    expect(selection.ok).toBe(true)
    if (selection.ok) {
      expect(selection.reviewer.providerId).toBe('p-beta')
      expect(selection.policyOutcome).toBe('satisfied')
    }
  })

  it('cross-provider-required sem segundo fornecedor devolve CROSS_PROVIDER_UNAVAILABLE', () => {
    expect(selectReviewer([mesmoFornecedor], EXECUTOR, 'cross-provider-required')).toEqual({
      ok: false,
      policy: 'cross-provider-required',
      reason: 'CROSS_PROVIDER_UNAVAILABLE',
    })
  })

  it('cross-provider-required nunca rebaixa em silencio (I10)', () => {
    const selection = selectReviewer([mesmoFornecedor], EXECUTOR, 'cross-provider-required')
    expect(selection.ok).toBe(false)
  })

  it('cross-provider-preferred com segundo fornecedor fica satisfied', () => {
    const selection = selectReviewer([outroFornecedor], EXECUTOR, 'cross-provider-preferred')
    expect(selection).toMatchObject({
      ok: true,
      policyOutcome: 'satisfied',
      effectivePolicy: 'cross-provider-preferred',
    })
  })

  it('cross-provider-preferred sem segundo fornecedor rebaixa e registra', () => {
    const selection = selectReviewer([mesmoFornecedor], EXECUTOR, 'cross-provider-preferred')
    expect(selection).toMatchObject({
      ok: true,
      policyOutcome: 'downgraded',
      effectivePolicy: 'fresh-session',
      reason: 'CROSS_PROVIDER_UNAVAILABLE',
    })
  })

  it('sem nenhum candidato elegivel devolve NO_REVIEWER_AVAILABLE', () => {
    expect(selectReviewer([EXECUTOR], EXECUTOR, 'fresh-session')).toMatchObject({
      ok: false,
      reason: 'NO_REVIEWER_AVAILABLE',
    })
    expect(selectReviewer([], EXECUTOR, 'cross-provider-preferred')).toMatchObject({
      ok: false,
      reason: 'NO_REVIEWER_AVAILABLE',
    })
  })

  it('prefere perfil diferente do executor e e deterministico', () => {
    const mesmoPerfil = identity('session-r3', 'p-beta', 'executor')
    const perfilDistinto = identity('session-r4', 'p-beta', 'reviewer')
    const primeira = selectReviewer([mesmoPerfil, perfilDistinto], EXECUTOR, 'fresh-session')
    const segunda = selectReviewer([mesmoPerfil, perfilDistinto], EXECUTOR, 'fresh-session')
    expect(primeira).toEqual(segunda)
    if (primeira.ok) expect(primeira.reviewer.sessionRef).toBe('session-r4')
  })
})
