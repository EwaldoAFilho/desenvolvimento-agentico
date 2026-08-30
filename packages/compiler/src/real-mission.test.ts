import { describe, expect, it } from 'vitest'
import { REAL_GATES_YAML } from './__fixtures__/real-gates.js'
import { REAL_MISSION_YAML } from './__fixtures__/real-mission.js'
import { REAL_PROJECT_YAML } from './__fixtures__/real-project.js'
import { compileMission, totalWork } from './compile.js'
import { bySeverity, codesOf } from './diagnostics.js'
import type { CompiledGraph } from './types.js'

const INPUT = {
  missionText: REAL_MISSION_YAML,
  projectFile: REAL_PROJECT_YAML,
  gatesFile: REAL_GATES_YAML,
}

function compiled(): CompiledGraph {
  const result = compileMission(INPUT)
  if (result.graph === undefined) {
    throw new Error(`missao real nao compilou: ${JSON.stringify(result.diagnostics)}`)
  }
  return result.graph
}

/**
 * A missao real do proprio projeto e o oraculo: os numeros abaixo vem do plano aprovado
 * (MVP-PLAN). Se o compilador discordar deles, o compilador esta errado.
 */
describe('missao real DA-CORE-001', () => {
  it('compila com zero ERROR', () => {
    const result = compileMission(INPUT)
    expect(bySeverity(result.diagnostics, 'ERROR')).toEqual([])
    expect(result.graph).toBeDefined()
  })

  it('tem 17 tasks e 7 fases', () => {
    const graph = compiled()
    expect(graph.nodes).toHaveLength(17)
    expect(new Set(graph.nodes.map((node) => node.task.phase)).size).toBe(7)
    expect(graph.missionId).toBe('DA-CORE-001')
  })

  it('nao tem ciclo: a ordem topologica cobre todas as tasks', () => {
    const graph = compiled()
    expect(graph.topologicalOrder).toHaveLength(17)
    expect(new Set(graph.topologicalOrder).size).toBe(17)
    expect(graph.topologicalOrder[0]).toBe('T01')
  })

  it('nao tem nenhum conflito de touches entre tasks concorrentes', () => {
    const graph = compiled()
    expect(graph.touchConflicts).toEqual([])
    expect(codesOf(graph.diagnostics)).not.toContain('DA2001')
  })

  it('agrupa o plano nas waves do plano aprovado', () => {
    const graph = compiled()
    expect(graph.waves.map((wave) => [...wave])).toEqual([
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

  it('tem caminho critico T01→T02→T03→T05→T10→T11→T13→T15 com comprimento 40', () => {
    const graph = compiled()
    expect([...graph.criticalPath.tasks]).toEqual([
      'T01',
      'T02',
      'T03',
      'T05',
      'T10',
      'T11',
      'T13',
      'T15',
    ])
    expect(graph.criticalPath.length).toBe(40)
  })

  it('soma 83 de trabalho total', () => {
    expect(totalWork(compiled())).toBe(83)
  })

  it('declara 26 dependencias e todas apontam para tasks existentes', () => {
    const graph = compiled()
    const ids = new Set(graph.nodes.map((node) => String(node.task.id)))
    for (const edge of graph.edges) {
      expect(ids.has(String(edge.from))).toBe(true)
      expect(ids.has(String(edge.to))).toBe(true)
    }
    expect(graph.edges).toHaveLength(26)
    expect(graph.edges.length).toBe(
      graph.nodes.reduce((sum, node) => sum + node.task.dependencies.length, 0),
    )
  })

  it('deriva dependents e depth coerentes com as waves', () => {
    const graph = compiled()
    const t01 = graph.nodes.find((node) => node.task.id === 'T01')
    expect([...(t01?.dependents ?? [])]).toEqual(['T02', 'T04', 'T16'])
    expect(t01?.depth).toBe(0)
    for (const node of graph.nodes) {
      expect(graph.waves[node.depth]).toContain(node.task.id)
    }
  })

  it('so produz WARNING de escopo de topo e INFO de fase, nunca ERROR', () => {
    const graph = compiled()
    expect(codesOf(bySeverity(graph.diagnostics, 'WARNING'))).toEqual(['DA2005', 'DA2005'])
    expect(codesOf(bySeverity(graph.diagnostics, 'INFO'))).toEqual(['DA3001', 'DA3001'])
  })

  it('cita a linha do arquivo em cada diagnostico da missao', () => {
    const graph = compiled()
    for (const item of graph.diagnostics) {
      expect(item.line).toBeGreaterThan(0)
    }
  })
})
