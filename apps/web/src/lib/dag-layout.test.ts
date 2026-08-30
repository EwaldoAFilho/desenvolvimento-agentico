import { describe, expect, it } from 'vitest'
import { makeSnapshot } from '../__fixtures__/snapshot.js'
import { boxesOverlap, type Grouping, layoutDag, phaseOrder } from './dag-layout.js'

const graph = makeSnapshot().graph

function overlappingPairs(grouping: Grouping): string[] {
  const { nodes } = layoutDag(graph, grouping)
  const pairs: string[] = []
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]
      const b = nodes[j]
      if (a !== undefined && b !== undefined && boxesOverlap(a, b)) pairs.push(`${a.id}/${b.id}`)
    }
  }
  return pairs
}

describe('layoutDag', () => {
  it('posiciona as 17 tasks da missao compilada', () => {
    expect(layoutDag(graph, 'phase').nodes).toHaveLength(17)
  })

  it('agrupa em 7 faixas na ordem declarada das fases', () => {
    const layout = layoutDag(graph, 'phase')
    expect(phaseOrder(graph)).toEqual([
      'foundation',
      'contracts',
      'backend',
      'frontend',
      'quality',
      'docs',
      'release',
    ])
    expect(layout.bands.map((band) => band.label)).toEqual(phaseOrder(graph))
  })

  it('usa as ondas do contrato, sem recalcular earliest start', () => {
    const layout = layoutDag(graph, 'wave')
    expect(layout.bands).toHaveLength(graph.waves.length)
    const bandOf = new Map(layout.nodes.map((node) => [node.id, node.band]))
    graph.waves.forEach((wave, index) => {
      for (const id of wave) expect(bandOf.get(id)).toBe(index)
    })
  })

  it('nenhuma caixa se sobrepoe — por fase', () => {
    expect(overlappingPairs('phase')).toEqual([])
  })

  it('nenhuma caixa se sobrepoe — por onda', () => {
    expect(overlappingPairs('wave')).toEqual([])
  })

  it('nenhuma caixa se sobrepoe — topologico', () => {
    expect(overlappingPairs('topological')).toEqual([])
  })

  it('e determinístico: duas chamadas dao exatamente a mesma geometria', () => {
    expect(layoutDag(graph, 'phase')).toEqual(layoutDag(graph, 'phase'))
  })

  it('nao depende do estado das tasks: a geometria so ve o grafo', () => {
    const before = layoutDag(makeSnapshot().graph, 'phase')
    const mutated = makeSnapshot()
    mutated.tasks = mutated.tasks.map((task) => ({ ...task, status: 'DONE' as const }))
    const after = layoutDag(mutated.graph, 'phase')
    expect(after.nodes).toEqual(before.nodes)
  })

  it('faixa alguma fica mais estreita que um no', () => {
    const layout = layoutDag(graph, 'phase')
    for (const band of layout.bands) expect(band.height).toBeGreaterThan(84)
    expect(layout.width).toBeGreaterThan(224)
  })
})
