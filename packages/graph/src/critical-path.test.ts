import { describe, expect, it } from 'vitest'
import {
  DIAMOND,
  DISCONNECTED,
  EMPTY,
  graphOf,
  LINEAR,
  MVP,
  mvpEstimate,
  PLANNING,
  planningWeight,
  SIMPLE_CYCLE,
  SINGLE,
} from './__fixtures__/graphs.js'
import { buildGraph } from './build.js'
import { longestPath, slack, waves } from './critical-path.js'

describe('longestPath', () => {
  it('conta um por no quando nao ha peso', () => {
    expect(longestPath(graphOf(LINEAR))).toEqual({ length: 4, path: ['A', 'B', 'C', 'D'] })
  })

  it('desempata pelo predecessor declarado primeiro', () => {
    expect(longestPath(graphOf(DIAMOND))).toEqual({ length: 3, path: ['A', 'B', 'D'] })
  })

  it('escolhe o ramo mais pesado, nao o mais longo em nos', () => {
    expect(longestPath(graphOf(PLANNING), planningWeight)).toEqual({
      length: 13,
      path: ['A', 'B', 'D', 'E'],
    })
  })

  it('prefere o ramo pesado ao ramo com mais nos', () => {
    // S -> L1 -> L2 -> L3 tem 4 nos e peso 4; S -> H tem 2 nos e peso 101.
    const built = buildGraph(
      ['S', 'L1', 'L2', 'L3', 'H'],
      [
        { from: 'S', to: 'L1' },
        { from: 'L1', to: 'L2' },
        { from: 'L2', to: 'L3' },
        { from: 'S', to: 'H' },
      ],
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const peso: Record<string, number> = { S: 1, L1: 1, L2: 1, L3: 1, H: 100 }
    expect(longestPath(built.graph, (node) => peso[node] ?? 0)).toEqual({
      length: 101,
      path: ['S', 'H'],
    })
    // Sem peso, o mesmo grafo devolve o ramo com mais nos: o peso e que decide.
    expect(longestPath(built.graph)).toEqual({ length: 4, path: ['S', 'L1', 'L2', 'L3'] })
  })

  it('escolhe o componente mais longo em grafo desconexo', () => {
    expect(longestPath(graphOf(DISCONNECTED))).toEqual({ length: 2, path: ['A', 'B'] })
  })

  it('trata grafo vazio e no unico', () => {
    expect(longestPath(graphOf(EMPTY))).toEqual({ length: 0, path: [] })
    expect(longestPath(graphOf(SINGLE))).toEqual({ length: 1, path: ['A'] })
  })

  it('devolve resultado vazio em grafo ciclico em vez de lancar', () => {
    expect(() => longestPath(graphOf(SIMPLE_CYCLE))).not.toThrow()
    expect(longestPath(graphOf(SIMPLE_CYCLE))).toEqual({ length: 0, path: [] })
  })

  it('reproduz o caminho critico publicado da missao', () => {
    expect(longestPath(graphOf(MVP), mvpEstimate)).toEqual({
      length: 40,
      path: ['T01', 'T02', 'T03', 'T05', 'T10', 'T11', 'T13', 'T15'],
    })
  })
})

describe('slack', () => {
  it('calcula ES/EF/LS/LF conferidos a mao', () => {
    const folga = slack(graphOf(PLANNING), planningWeight)
    expect(folga.get('A')).toEqual({ es: 0, ef: 2, ls: 0, lf: 2, slack: 0 })
    expect(folga.get('B')).toEqual({ es: 2, ef: 8, ls: 2, lf: 8, slack: 0 })
    expect(folga.get('C')).toEqual({ es: 2, ef: 5, ls: 5, lf: 8, slack: 3 })
    expect(folga.get('D')).toEqual({ es: 8, ef: 12, ls: 8, lf: 12, slack: 0 })
    expect(folga.get('E')).toEqual({ es: 12, ef: 13, ls: 12, lf: 13, slack: 0 })
  })

  it('da folga zero exatamente ao caminho critico', () => {
    const folga = slack(graphOf(PLANNING), planningWeight)
    const criticos = [...folga.entries()]
      .filter(([, value]) => value.slack === 0)
      .map(([node]) => node)
    expect(criticos).toEqual(['A', 'B', 'D', 'E'])
  })

  it('itera em ordem de declaracao', () => {
    expect([...slack(graphOf(DIAMOND)).keys()]).toEqual(['A', 'B', 'C', 'D'])
  })

  it('trata todo no de grafo desconexo contra o mesmo fim de projeto', () => {
    const folga = slack(graphOf(DISCONNECTED))
    expect(folga.get('Z')).toEqual({ es: 0, ef: 1, ls: 1, lf: 2, slack: 1 })
    expect(folga.get('A')?.slack).toBe(0)
  })

  it('devolve mapa vazio em grafo ciclico', () => {
    expect(slack(graphOf(SIMPLE_CYCLE)).size).toBe(0)
    expect(slack(graphOf(EMPTY)).size).toBe(0)
  })

  it('reproduz as folgas publicadas da missao', () => {
    const folga = slack(graphOf(MVP), mvpEstimate)
    const publicado: Record<string, number> = {
      T01: 0,
      T02: 0,
      T03: 0,
      T04: 7,
      T05: 0,
      T16: 4,
      T06: 8,
      T07: 6,
      T08: 7,
      T17: 1,
      T09: 1,
      T10: 0,
      T11: 0,
      T12: 1,
      T13: 0,
      T14: 16,
      T15: 0,
    }
    const calculado = Object.fromEntries([...folga].map(([node, value]) => [node, value.slack]))
    expect(calculado).toEqual(publicado)
    expect(folga.get('T15')?.ef).toBe(40)
  })
})

describe('waves', () => {
  it('agrupa cadeia linear em uma onda por no', () => {
    expect(waves(graphOf(LINEAR))).toEqual([['A'], ['B'], ['C'], ['D']])
  })

  it('agrupa os ramos do diamante na mesma onda', () => {
    expect(waves(graphOf(DIAMOND))).toEqual([['A'], ['B', 'C'], ['D']])
  })

  it('poe origens de componentes distintos na primeira onda', () => {
    expect(waves(graphOf(DISCONNECTED))).toEqual([
      ['A', 'X', 'Z'],
      ['B', 'Y'],
    ])
  })

  it('agrupa o grafo de planejamento por earliest start', () => {
    expect(waves(graphOf(PLANNING))).toEqual([['A'], ['B', 'C'], ['D'], ['E']])
  })

  it('usa o predecessor mais profundo quando existe atalho', () => {
    // A -> C existe, mas C so pode comecar depois de B: onda 2, nao onda 1.
    const built = buildGraph(
      ['A', 'B', 'C'],
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
        { from: 'B', to: 'C' },
      ],
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(waves(built.graph)).toEqual([['A'], ['B'], ['C']])
  })

  it('devolve lista vazia em grafo vazio ou ciclico', () => {
    expect(waves(graphOf(EMPTY))).toEqual([])
    expect(waves(graphOf(SIMPLE_CYCLE))).toEqual([])
  })

  it('reproduz as ondas publicadas da missao', () => {
    expect(waves(graphOf(MVP))).toEqual([
      ['T01'],
      ['T02', 'T04', 'T16'],
      ['T03', 'T06', 'T08', 'T17'],
      ['T05', 'T07', 'T09', 'T14'],
      ['T10'],
      ['T11'],
      ['T12', 'T13'],
      ['T15'],
    ])
  })
})
