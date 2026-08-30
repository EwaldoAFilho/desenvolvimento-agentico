import { describe, expect, it } from 'vitest'
import { graphOf, shuffled, spec, specsOf, T } from './__fixtures__/builders.js'
import { buildPlan, comparePriority, sortByPriority } from './priority.js'

const CHAIN = [
  spec('T01'),
  spec('T02', { dependencies: [T('T01')] }),
  spec('T03', { dependencies: [T('T02')] }),
  spec('T04'),
]

describe('buildPlan — indices derivados do grafo congelado', () => {
  const plan = buildPlan(graphOf(CHAIN), specsOf(CHAIN))

  it('marca o caminho critico', () => {
    expect(plan.isCritical(T('T01'))).toBe(true)
    expect(plan.isCritical(T('T03'))).toBe(true)
    expect(plan.isCritical(T('T04'))).toBe(false)
  })

  it('conta dependentes diretos', () => {
    expect(plan.dependentsOf(T('T01'))).toBe(1)
    expect(plan.dependentsOf(T('T03'))).toBe(0)
  })

  it('usa a ordem topologica congelada, nao a de declaracao', () => {
    const reordered = buildPlan(graphOf(CHAIN, ['T04', 'T01', 'T02', 'T03']), specsOf(CHAIN))
    expect(reordered.topoIndexOf(T('T04'))).toBe(0)
    expect(reordered.topoIndexOf(T('T01'))).toBe(1)
  })

  it('task fora da ordem congelada vai para o fim', () => {
    const partial = buildPlan(graphOf(CHAIN, ['T01', 'T02']), specsOf(CHAIN))
    expect(partial.topoIndexOf(T('T04'))).toBeGreaterThan(partial.topoIndexOf(T('T02')))
  })

  it('estimate pesa o caminho critico', () => {
    const heavy = [spec('T01', { estimate: 99 }), spec('T02', { dependencies: [T('T01')] })]
    const plan99 = buildPlan(graphOf(heavy), specsOf(heavy))
    expect(plan99.isCritical(T('T01'))).toBe(true)
  })

  it('spec do mapa complementa o grafo congelado', () => {
    const loose = spec('T09')
    const empty = { specHash: 'sha256:x', tasks: [], edges: [], topologicalOrder: [] }
    const merged = buildPlan(empty, new Map([[loose.id, loose]]))
    expect(merged.specOf(T('T09'))).toBe(loose)
  })

  it('grafo vazio nao produz caminho critico', () => {
    const empty = { specHash: 'sha256:x', tasks: [], edges: [], topologicalOrder: [] }
    const none = buildPlan(empty, new Map())
    expect(none.isCritical(T('T01'))).toBe(false)
    expect(none.dependentsOf(T('T01'))).toBe(0)
  })
})

describe('comparePriority — ordem obrigatoria dos criterios', () => {
  it('(a) caminho critico vence numero de dependentes', () => {
    const tasks = [
      spec('T01', { estimate: 10 }),
      spec('T02'),
      spec('T03', { dependencies: [T('T02')] }),
      spec('T04', { dependencies: [T('T02')] }),
    ]
    const plan = buildPlan(graphOf(tasks), specsOf(tasks))
    expect(comparePriority(plan, T('T01'), T('T02'))).toBeLessThan(0)
  })

  it('(b) mais dependentes primeiro', () => {
    const tasks = [
      spec('T01'),
      spec('T02'),
      spec('T03', { estimate: 50 }),
      spec('T04', { dependencies: [T('T01')] }),
    ]
    const plan = buildPlan(graphOf(tasks), specsOf(tasks))
    expect(comparePriority(plan, T('T01'), T('T02'))).toBeLessThan(0)
  })

  it('(c) risco alto primeiro', () => {
    const tasks = [
      spec('T01', { risk: 'low' }),
      spec('T02', { risk: 'high' }),
      spec('T03', { estimate: 50 }),
    ]
    const plan = buildPlan(graphOf(tasks), specsOf(tasks))
    expect(comparePriority(plan, T('T02'), T('T01'))).toBeLessThan(0)
  })

  it('(c) medium fica entre high e low', () => {
    const tasks = [
      spec('T01', { risk: 'medium' }),
      spec('T02', { risk: 'low' }),
      spec('T03', { estimate: 50 }),
    ]
    const plan = buildPlan(graphOf(tasks), specsOf(tasks))
    expect(comparePriority(plan, T('T01'), T('T02'))).toBeLessThan(0)
  })

  it('(d) ordem topologica canonica fecha o desempate', () => {
    const tasks = [spec('T01'), spec('T02'), spec('T03', { estimate: 50 })]
    const plan = buildPlan(graphOf(tasks, ['T03', 'T02', 'T01']), specsOf(tasks))
    expect(comparePriority(plan, T('T02'), T('T01'))).toBeLessThan(0)
  })

  it('comparar uma task consigo mesma da empate', () => {
    const plan = buildPlan(graphOf(CHAIN), specsOf(CHAIN))
    expect(comparePriority(plan, T('T01'), T('T01'))).toBe(0)
  })

  it('sem spec o risco assume medium', () => {
    const tasks = [spec('T01', { risk: 'low' }), spec('T02', { estimate: 50 })]
    const plan = buildPlan(graphOf(tasks), specsOf(tasks))
    expect(comparePriority(plan, T('T77'), T('T01'))).toBeLessThan(0)
  })
})

describe('sortByPriority — ordem total e estavel sob embaralhamento', () => {
  const tasks = [
    spec('T01', { risk: 'low' }),
    spec('T02', { risk: 'high' }),
    spec('T03', { estimate: 50 }),
    spec('T04', { risk: 'medium' }),
  ]
  const plan = buildPlan(graphOf(tasks), specsOf(tasks))
  const ids = [T('T01'), T('T02'), T('T04')]

  it('produz a mesma ordem para qualquer permutacao', () => {
    const expected = sortByPriority(plan, ids, (id) => id)
    expect(sortByPriority(plan, shuffled(ids), (id) => id)).toEqual(expected)
    expect(sortByPriority(plan, shuffled(shuffled(ids)), (id) => id)).toEqual(expected)
  })

  it('nao muta a lista recebida', () => {
    const original = [...ids]
    sortByPriority(plan, ids, (id) => id)
    expect(ids).toEqual(original)
  })

  it('ordena por risco quando o resto empata', () => {
    expect(sortByPriority(plan, ids, (id) => id)).toEqual([T('T02'), T('T04'), T('T01')])
  })
})
