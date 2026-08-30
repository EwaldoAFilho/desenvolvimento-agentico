import { describe, expect, it } from 'vitest'
import { compileInput } from './__fixtures__/builders.js'
import { REAL_GATES_YAML } from './__fixtures__/real-gates.js'
import { REAL_MISSION_YAML } from './__fixtures__/real-mission.js'
import { REAL_PROJECT_YAML } from './__fixtures__/real-project.js'
import { compiledTasks, compileMission, totalWork } from './compile.js'
import { toFrozenGraph } from './frozen.js'
import type { CompiledGraph } from './types.js'

function baseline(): CompiledGraph {
  const result = compileMission(compileInput())
  if (result.graph === undefined) throw new Error('base limpa deveria compilar')
  return result.graph
}

describe('CompiledGraph', () => {
  it('lista as tasks na ordem de declaracao', () => {
    expect([...compiledTasks(baseline())]).toEqual(['T01', 'T02', 'T03', 'T04'])
  })

  it('deriva as arestas a partir das dependencias declaradas', () => {
    expect(baseline().edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      'T01->T02',
      'T01->T03',
      'T02->T04',
      'T03->T04',
    ])
  })

  it('produz ordem topologica com desempate por ordem de declaracao', () => {
    expect([...baseline().topologicalOrder]).toEqual(['T01', 'T02', 'T03', 'T04'])
  })

  it('agrupa por earliest start', () => {
    expect(baseline().waves.map((wave) => [...wave])).toEqual([['T01'], ['T02', 'T03'], ['T04']])
  })

  it('mede o caminho critico pelos estimates', () => {
    const graph = baseline()
    expect([...graph.criticalPath.tasks]).toEqual(['T01', 'T02', 'T04'])
    expect(graph.criticalPath.length).toBe(6)
    expect(totalWork(graph)).toBe(8)
  })

  it('lista os pares sem relacao de ordem', () => {
    expect(baseline().concurrencyMatrix.map((pair) => [...pair])).toEqual([['T02', 'T03']])
  })

  it('anota dependents e depth em cada no', () => {
    const nodes = baseline().nodes
    expect(nodes.map((node) => [String(node.task.id), node.depth])).toEqual([
      ['T01', 0],
      ['T02', 1],
      ['T03', 1],
      ['T04', 2],
    ])
    expect([...(nodes[0]?.dependents ?? [])]).toEqual(['T02', 'T03'])
    expect([...(nodes[3]?.dependents ?? [])]).toEqual([])
  })

  it('resolve os defaults da missao dentro de cada TaskSpec', () => {
    const first = baseline().nodes[0]?.task
    expect(first?.gate).toBe('unit')
    expect(first?.requireReview).toBe(true)
    expect(first?.maxAttempts).toBe(3)
    expect(first?.agentProfile).toBe('executor')
  })
})

describe('toFrozenGraph', () => {
  it('reduz o grafo a forma que o dominio congela no Run', () => {
    const graph = baseline()
    const frozen = toFrozenGraph(graph)
    expect(frozen.specHash).toBe(graph.specHash)
    expect(frozen.tasks.map((task) => String(task.id))).toEqual(['T01', 'T02', 'T03', 'T04'])
    expect(frozen.edges).toEqual(graph.edges)
    expect(frozen.topologicalOrder).toEqual(graph.topologicalOrder)
  })

  it('serializa a missao real inteira sem perder task', () => {
    const result = compileMission({
      missionText: REAL_MISSION_YAML,
      projectFile: REAL_PROJECT_YAML,
      gatesFile: REAL_GATES_YAML,
    })
    if (result.graph === undefined) throw new Error('missao real deveria compilar')
    const frozen = toFrozenGraph(result.graph)
    expect(frozen.tasks).toHaveLength(17)
    expect(JSON.parse(JSON.stringify(frozen)).tasks).toHaveLength(17)
  })
})
