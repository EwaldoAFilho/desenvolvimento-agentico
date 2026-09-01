import type { CompileReportDto, RunPoliciesDto } from '@agentic/schemas'
import { describe, expect, it } from 'vitest'
import { makePlanTaskDetail } from '../__fixtures__/planning.js'
import { makeCompileReport, makeSnapshot } from '../__fixtures__/snapshot.js'
import {
  conflictKindOf,
  conflictsOf,
  dependentsOf,
  diagnosticsFor,
  planStatsLine,
  reviewReadingOf,
} from './plan-review.js'

const POLICIES: RunPoliciesDto = makeSnapshot().run.policies

function reportWith(diagnostics: CompileReportDto['diagnostics']): CompileReportDto {
  const base = makeCompileReport('clean')
  return { ...base, diagnostics }
}

describe('conflitos do plano', () => {
  it('escopo sobreposto entre concorrentes e conflito', () => {
    const conflicts = conflictsOf(makeCompileReport('warning'))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.code).toBe('DA2001')
    expect(conflictKindOf('DA2001')).toContain('escopo')
  })

  it('aviso que fala de UMA task sozinha nao e conflito', () => {
    const report = reportWith([
      {
        code: 'DA2007',
        severity: 'WARNING',
        message: 'T12 tem risk high com requireReview false',
        targets: ['T12'],
      },
      {
        code: 'DA2005',
        severity: 'WARNING',
        message: 'touches de T03 cobre o pacote inteiro',
        targets: ['T03'],
      },
    ])
    expect(conflictsOf(report)).toHaveLength(0)
  })

  it('ciclo de dependencia conta como conflito, e o tipo diz de que natureza', () => {
    const report = reportWith([
      {
        code: 'DA1005',
        severity: 'ERROR',
        message: 'ciclo entre T05 e T09',
        targets: ['T05', 'T09'],
      },
    ])
    expect(conflictsOf(report)).toHaveLength(1)
    expect(conflictKindOf('DA1005')).toContain('dependência')
    expect(conflictKindOf('DA3002')).toBeUndefined()
  })
})

describe('os numeros do compilador', () => {
  it('a linha do plano mostra tasks, paralelismo, avisos, caminho critico e conflitos', () => {
    const line = planStatsLine(makeCompileReport('warning'))
    expect(line).toContain('17 tasks')
    expect(line).toContain('caminho crítico 8 tasks')
    expect(line).toContain('paralelismo máximo 4')
    expect(line).toContain('2 avisos')
    expect(line).toContain('1 conflitos')
  })

  it('avisos e erros saem da lista mostrada, nunca de uma segunda fonte', () => {
    const report: CompileReportDto = {
      ...makeCompileReport('warning'),
      // `stats` desatualizado: quem manda e a lista que a tela exibe logo abaixo.
      stats: { ...makeCompileReport('warning').stats, warnings: 99, errors: 42 },
    }
    const line = planStatsLine(report)
    expect(line).toContain('2 avisos')
    expect(line).toContain('0 erros')
    expect(line).not.toContain('99')
  })
})

describe('leitura por no', () => {
  it('o diagnostico do no e o que cita o no', () => {
    const report = makeCompileReport('warning')
    expect(diagnosticsFor(report, 'T09').map((item) => item.code)).toEqual(['DA2001'])
    expect(diagnosticsFor(report, 'T12').map((item) => item.code)).toEqual(['DA2007'])
    expect(diagnosticsFor(report, 'T01')).toHaveLength(0)
  })

  it('quem espera pela task sai das arestas do grafo congelado', () => {
    const graph = makeSnapshot().graph
    expect(dependentsOf(graph, 'T05')).toEqual(['T09', 'T11'])
    expect(dependentsOf(graph, 'T17')).toEqual([])
  })
})

describe('o que a tela pode dizer sobre revisao', () => {
  it('sem tentativa, nao inventa politica: diz o que o run admite', () => {
    const text = reviewReadingOf(makePlanTaskDetail(), POLICIES)
    expect(text).toContain('registrada na tentativa')
    expect(text).toContain('2 revisor(es)')
  })

  it('run sem revisor diz que nenhuma revisao sera despachada', () => {
    const text = reviewReadingOf(undefined, { ...POLICIES, maxReviewers: 0 })
    expect(text).toContain('não admite revisor')
  })

  it('com politica aplicada, mostra a politica — e o rebaixamento quando houver (I10)', () => {
    const base = makePlanTaskDetail()
    const applied = {
      ...base,
      review: { ...base.review, policy: 'cross-provider-required' as const },
    }
    expect(reviewReadingOf(applied, POLICIES)).toBe('cross-provider-required — aplicada')

    const downgraded = {
      ...applied,
      review: { ...applied.review, policyOutcome: 'downgraded' as const },
    }
    expect(reviewReadingOf(downgraded, POLICIES)).toContain('rebaixada')
  })
})

describe('leitura de revisao do no do plano', () => {
  const policies = { maxReviewers: 2 } as never

  it('requireReview false NAO esconde a politica declarada', () => {
    // O schema aceita a combinacao. Esconder faria o no parecer mais simples do que e,
    // exatamente onde o humano decide se aprova.
    const texto = reviewReadingOf(undefined, policies, {
      requireReview: false,
      reviewPolicy: 'cross-provider-required',
    })
    expect(texto).toContain('não exige revisão')
    expect(texto).toContain('cross-provider-required')
  })

  it('mostra o que a task declara, nao so o teto de revisores do run', () => {
    const texto = reviewReadingOf(undefined, policies, {
      requireReview: true,
      reviewPolicy: 'cross-provider-required',
    })
    expect(texto).toContain('revisão exigida')
    expect(texto).toContain('cross-provider-required')
  })
})
