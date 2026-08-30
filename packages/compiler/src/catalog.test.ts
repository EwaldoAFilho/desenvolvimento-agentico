import { describe, expect, it } from 'vitest'
import { DIAGNOSTIC_CATALOG, isDiagnosticCode, severityOf } from './catalog.js'
import { diagnostic, sortDiagnostics } from './diagnostics.js'
import { DIAGNOSTIC_CODES } from './types.js'

/** A tabela de ARCHITECTURE 7.1, transcrita: 22 codigos, cada um com sua severidade. */
const EXPECTED: readonly (readonly [string, 'ERROR' | 'WARNING' | 'INFO'])[] = [
  ['DA1000', 'ERROR'],
  ['DA1001', 'ERROR'],
  ['DA1002', 'ERROR'],
  ['DA1003', 'ERROR'],
  ['DA1004', 'ERROR'],
  ['DA1005', 'ERROR'],
  ['DA1006', 'ERROR'],
  ['DA1007', 'ERROR'],
  ['DA1008', 'ERROR'],
  ['DA1009', 'ERROR'],
  ['DA1010', 'ERROR'],
  ['DA1011', 'ERROR'],
  ['DA2001', 'WARNING'],
  ['DA2002', 'WARNING'],
  ['DA2003', 'WARNING'],
  ['DA2004', 'WARNING'],
  ['DA2005', 'WARNING'],
  ['DA2006', 'WARNING'],
  ['DA2007', 'WARNING'],
  ['DA2008', 'WARNING'],
  ['DA3001', 'INFO'],
  ['DA3002', 'INFO'],
]

describe('catalogo de diagnosticos', () => {
  it('tem exatamente os 22 codigos do documento', () => {
    expect([...DIAGNOSTIC_CODES]).toEqual(EXPECTED.map(([code]) => code))
    expect(Object.keys(DIAGNOSTIC_CATALOG)).toEqual(EXPECTED.map(([code]) => code))
  })

  it('respeita a severidade documentada de cada codigo', () => {
    for (const [code, severity] of EXPECTED) {
      expect(severityOf(code as (typeof DIAGNOSTIC_CODES)[number])).toBe(severity)
    }
  })

  it('descreve e sugere acao para cada codigo', () => {
    for (const entry of Object.values(DIAGNOSTIC_CATALOG)) {
      expect(entry.title.length).toBeGreaterThan(0)
      expect(entry.hint.length).toBeGreaterThan(0)
    }
  })

  it('reconhece codigo do catalogo e recusa codigo inventado', () => {
    expect(isDiagnosticCode('DA2001')).toBe(true)
    expect(isDiagnosticCode('DA9999')).toBe(false)
  })

  it('o construtor toma a severidade do catalogo, nao do chamador', () => {
    const item = diagnostic('DA2001', { message: 'x', targets: ['T01', 'T02'] })
    expect(item.severity).toBe('WARNING')
    expect(item.hint).toBe(DIAGNOSTIC_CATALOG.DA2001.hint)
  })

  it('ordena ERROR antes de WARNING antes de INFO', () => {
    const sorted = sortDiagnostics([
      diagnostic('DA3002', { message: 'c', targets: [] }),
      diagnostic('DA2001', { message: 'b', targets: [] }),
      diagnostic('DA1002', { message: 'a', targets: [] }),
    ])
    expect(sorted.map((item) => item.code)).toEqual(['DA1002', 'DA2001', 'DA3002'])
  })

  it('desempata por codigo e por alvo, ignorando a ordem de emissao', () => {
    const build = () => [
      diagnostic('DA1003', { message: 'x', targets: ['T02', 'T99'] }),
      diagnostic('DA1003', { message: 'x', targets: ['T01', 'T99'] }),
      diagnostic('DA1002', { message: 'y', targets: ['T03'] }),
    ]
    const first = sortDiagnostics(build())
    const second = sortDiagnostics([...build()].reverse())
    expect(first).toEqual(second)
    expect(first.map((item) => item.targets[0])).toEqual(['T03', 'T01', 'T02'])
  })
})
