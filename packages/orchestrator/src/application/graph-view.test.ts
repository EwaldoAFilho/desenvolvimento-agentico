import type { FrozenGraph, TaskSpec } from '@agentic/domain'
import { pathScope, phaseId, taskId as toTaskId } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import { graphViewOf } from './graph-view.js'

function spec(id: string, dependencies: string[], estimate = 1): TaskSpec {
  return {
    id: toTaskId(id),
    phase: phaseId('build'),
    title: id,
    objective: id,
    dependencies: dependencies.map(toTaskId),
    touches: [pathScope(`packages/${id.toLowerCase()}/`)],
    validation: [],
    risk: 'low',
    estimate,
  }
}

const tasks = [spec('T01', []), spec('T02', ['T01'], 5), spec('T03', ['T01'])]
const frozen: FrozenGraph = {
  specHash: 'fnv1a64:0',
  tasks,
  edges: [
    { from: toTaskId('T01'), to: toTaskId('T02') },
    { from: toTaskId('T01'), to: toTaskId('T03') },
  ],
  topologicalOrder: [toTaskId('T01'), toTaskId('T02'), toTaskId('T03')],
}

describe('graphViewOf', () => {
  it('agrupa em ondas a partir do grafo congelado', () => {
    expect(graphViewOf(frozen).waves).toEqual([['T01'], ['T02', 'T03']])
  })

  it('usa o estimate como peso do caminho critico', () => {
    expect(graphViewOf(frozen).criticalPath).toEqual(['T01', 'T02'])
  })

  it('aceita peso observado e muda o caminho critico', () => {
    const view = graphViewOf(frozen, (task) => (task.id === 'T03' ? 100 : 1))
    expect(view.criticalPath).toEqual(['T01', 'T03'])
  })

  it('calcula folga por no', () => {
    const view = graphViewOf(frozen)
    expect(view.slack.T01).toBe(0)
    expect(view.slack.T03).toBeGreaterThan(0)
  })
})
