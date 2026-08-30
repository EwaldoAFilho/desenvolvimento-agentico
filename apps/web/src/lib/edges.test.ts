import { describe, expect, it } from 'vitest'
import { makeSnapshot } from '../__fixtures__/snapshot.js'
import { classifyEdge, criticalPathEdges, EDGE_LABEL, edgeKey } from './edges.js'

describe('classificacao de arestas', () => {
  it('dependencia concluida fica verde', () => {
    expect(classifyEdge('DONE', 'RUNNING')).toBe('satisfied')
    expect(classifyEdge('SKIPPED', 'READY')).toBe('satisfied')
  })

  it('dependencia ainda em curso fica cinza', () => {
    expect(classifyEdge('RUNNING', 'PENDING')).toBe('unsatisfied')
    expect(classifyEdge('PENDING', 'PENDING')).toBe('unsatisfied')
  })

  it('destino bloqueado tem precedencia e fica ambar', () => {
    expect(classifyEdge('DONE', 'BLOCKED')).toBe('blocked-target')
    expect(EDGE_LABEL['blocked-target']).toBe('destino bloqueado')
  })

  it('caminho critico vem do contrato, em pares consecutivos', () => {
    const graph = makeSnapshot().graph
    const critical = criticalPathEdges(graph)
    expect(critical.has(edgeKey({ from: 'T01', to: 'T03' }))).toBe(true)
    expect(critical.has(edgeKey({ from: 'T16', to: 'T17' }))).toBe(true)
    expect(critical.has(edgeKey({ from: 'T01', to: 'T04' }))).toBe(false)
    expect(critical.size).toBe(graph.criticalPath.length - 1)
  })
})
