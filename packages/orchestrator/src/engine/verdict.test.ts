import { describe, expect, it } from 'vitest'
import { parseReview } from './verdict.js'

describe('parseReview', () => {
  it('le o veredito PASS declarado pelo revisor', () => {
    expect(parseReview({ summary: 'VERDICT: PASS' }).verdict).toBe('PASS')
  })

  it('aceita a forma em portugues e ignora caixa', () => {
    expect(parseReview({ summary: 'veredito = fail' }).verdict).toBe('FAIL')
  })

  it('le ESCALATE no detalhe', () => {
    const parsed = parseReview({ summary: 'analise', detail: 'VERDICT: ESCALATE' })
    expect(parsed.verdict).toBe('ESCALATE')
  })

  it('aceita o veredito isolado em uma linha, como o prompt pede', () => {
    const parsed = parseReview({ summary: 'revisei o diff', detail: 'escopo ok\nPASS\n' })
    expect(parsed.verdict).toBe('PASS')
  })

  it('nao confunde a palavra no meio de uma frase com veredito', () => {
    expect(parseReview({ summary: 'o gate PASS ja tinha rodado antes' }).verdict).toBeUndefined()
  })

  it('nao inventa aprovacao quando nao ha veredito', () => {
    expect(parseReview({ summary: 'achei tudo otimo' }).verdict).toBeUndefined()
    expect(parseReview(undefined).verdict).toBeUndefined()
  })

  it('coleta achados com severidade declarada', () => {
    const parsed = parseReview({
      summary: 'VERDICT: FAIL',
      detail: ['FINDING [error]: falta teste', 'ACHADO: nome confuso'].join('\n'),
    })
    expect(parsed.findings).toEqual([
      { severity: 'error', message: 'falta teste' },
      { severity: 'warning', message: 'nome confuso' },
    ])
  })

  it('usa o resumo do revisor como justificativa', () => {
    expect(parseReview({ summary: 'VERDICT: PASS' }).rationale).toBe('VERDICT: PASS')
  })
})
