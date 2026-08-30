import { describe, expect, it } from 'vitest'
import {
  DIAMOND,
  DISCONNECTED,
  EMPTY,
  graphOf,
  LINEAR,
  MVP,
  SELF_LOOP,
  SIMPLE_CYCLE,
  SINGLE,
} from './__fixtures__/graphs.js'
import { concurrentPairs, transitiveClosure } from './reachability.js'

describe('transitiveClosure', () => {
  it('alcanca por transitividade na cadeia linear', () => {
    const closure = transitiveClosure(graphOf(LINEAR))
    expect(closure.reaches('A', 'D')).toBe(true)
    expect(closure.reaches('B', 'D')).toBe(true)
    expect(closure.reaches('C', 'D')).toBe(true)
  })

  it('nao alcanca na direcao contraria', () => {
    const closure = transitiveClosure(graphOf(LINEAR))
    expect(closure.reaches('D', 'A')).toBe(false)
    expect(closure.reaches('C', 'B')).toBe(false)
  })

  it('nao alcanca entre ramos paralelos do diamante', () => {
    const closure = transitiveClosure(graphOf(DIAMOND))
    expect(closure.reaches('B', 'C')).toBe(false)
    expect(closure.reaches('C', 'B')).toBe(false)
    expect(closure.reaches('A', 'D')).toBe(true)
  })

  it('nao alcanca entre componentes desconexos', () => {
    const closure = transitiveClosure(graphOf(DISCONNECTED))
    expect(closure.reaches('A', 'Y')).toBe(false)
    expect(closure.reaches('X', 'B')).toBe(false)
    expect(closure.reaches('Z', 'A')).toBe(false)
  })

  it('so alcanca a si mesmo quando o no esta em ciclo', () => {
    expect(transitiveClosure(graphOf(LINEAR)).reaches('A', 'A')).toBe(false)
    expect(transitiveClosure(graphOf(SIMPLE_CYCLE)).reaches('A', 'A')).toBe(true)
    expect(transitiveClosure(graphOf(SELF_LOOP)).reaches('A', 'A')).toBe(true)
    expect(transitiveClosure(graphOf(SELF_LOOP)).reaches('B', 'B')).toBe(false)
  })

  it('lista os alcancaveis em ordem de declaracao', () => {
    const closure = transitiveClosure(graphOf(DIAMOND))
    expect(closure.reachable('A')).toEqual(['B', 'C', 'D'])
    expect(closure.reachable('B')).toEqual(['D'])
    expect(closure.reachable('D')).toEqual([])
  })

  it('trata no desconhecido sem lancar', () => {
    const closure = transitiveClosure(graphOf(LINEAR))
    expect(closure.reaches('inexistente', 'A')).toBe(false)
    expect(closure.reaches('A', 'inexistente')).toBe(false)
    expect(closure.reachable('inexistente')).toEqual([])
  })

  it('atravessa o DAG da missao ate o fim', () => {
    const closure = transitiveClosure(graphOf(MVP))
    expect(closure.reaches('T01', 'T15')).toBe(true)
    expect(closure.reaches('T04', 'T11')).toBe(true)
    expect(closure.reaches('T04', 'T14')).toBe(false)
    expect(closure.reaches('T14', 'T11')).toBe(false)
  })
})

describe('concurrentPairs', () => {
  it('nao ve concorrencia em cadeia linear', () => {
    expect(concurrentPairs(graphOf(LINEAR))).toEqual([])
  })

  it('ve so os ramos do diamante', () => {
    expect(concurrentPairs(graphOf(DIAMOND))).toEqual([['B', 'C']])
  })

  it('ve todos os pares entre componentes desconexos', () => {
    expect(concurrentPairs(graphOf(DISCONNECTED))).toEqual([
      ['A', 'X'],
      ['A', 'Y'],
      ['A', 'Z'],
      ['B', 'X'],
      ['B', 'Y'],
      ['B', 'Z'],
      ['X', 'Z'],
      ['Y', 'Z'],
    ])
  })

  it('nao ve concorrencia em grafo vazio nem com no unico', () => {
    expect(concurrentPairs(graphOf(EMPTY))).toEqual([])
    expect(concurrentPairs(graphOf(SINGLE))).toEqual([])
  })

  it('nao pareia nos do mesmo ciclo', () => {
    expect(concurrentPairs(graphOf(SIMPLE_CYCLE))).toEqual([])
  })

  it('conta os 50 pares concorrentes publicados para a missao', () => {
    const pairs = concurrentPairs(graphOf(MVP))
    expect(pairs).toHaveLength(50)
    expect(pairs).toContainEqual(['T02', 'T04'])
    expect(pairs).not.toContainEqual(['T01', 'T02'])
  })
})
