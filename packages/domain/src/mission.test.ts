import { describe, expect, it } from 'vitest'
import { MISSION, T01, T02, T03 } from './__fixtures__/builders.js'
import { gateId, phaseId } from './ids.js'
import {
  checkMissionSpecInvariants,
  checkTaskSpecInvariants,
  type MissionSpec,
  missionDependencies,
  resolveTaskSettings,
  type TaskSpec,
  taskDependents,
} from './mission.js'
import { pathScope } from './path-scope.js'

function task(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: T01,
    phase: phaseId('core'),
    title: 'Titulo',
    objective: 'Objetivo verificavel',
    dependencies: [],
    touches: [pathScope('packages/domain/')],
    validation: ['tem teste'],
    risk: 'medium',
    ...overrides,
  }
}

function spec(overrides: Partial<MissionSpec> = {}): MissionSpec {
  return {
    id: MISSION,
    title: 'Missao',
    objective: 'Objetivo',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: ['criterio'],
    defaults: { requireReview: true, maxAttempts: 3, gate: gateId('unit') },
    phases: [{ id: phaseId('core'), title: 'Core' }],
    tasks: [task(), task({ id: T02, dependencies: [T01] }), task({ id: T03, dependencies: [T02] })],
    ...overrides,
  }
}

describe('entidades de definicao', () => {
  it('resolve defaults da missao para a task', () => {
    expect(resolveTaskSettings(task(), spec().defaults)).toEqual({
      requireReview: true,
      maxAttempts: 3,
      gate: 'unit',
      agentProfile: undefined,
    })
  })

  it('override da task vence o default da missao', () => {
    const settings = resolveTaskSettings(
      task({ requireReview: false, maxAttempts: 1, gate: gateId('backend') }),
      spec().defaults,
    )
    expect(settings).toMatchObject({ requireReview: false, maxAttempts: 1, gate: 'backend' })
  })

  it('deriva as arestas do DAG a partir das dependencias declaradas (P02)', () => {
    expect(missionDependencies(spec())).toEqual([
      { from: T01, to: T02 },
      { from: T02, to: T03 },
    ])
    expect(taskDependents(spec(), T01)).toEqual([T02])
  })

  it('acusa objetivo vazio, auto-referencia e maxAttempts invalido', () => {
    expect(checkTaskSpecInvariants(task({ objective: '  ' }))).toContain(
      'objective nao pode ser vazio',
    )
    expect(checkTaskSpecInvariants(task({ dependencies: [T01] }))).toContain(
      'dependencies nao pode auto-referenciar',
    )
    expect(checkTaskSpecInvariants(task({ maxAttempts: 0 }))).toContain('maxAttempts deve ser >= 1')
    expect(checkTaskSpecInvariants(task())).toEqual([])
  })

  it('acusa fase inexistente e dependencia para task ausente', () => {
    const problemas = checkMissionSpecInvariants(
      spec({ tasks: [task({ phase: phaseId('inexistente'), dependencies: [T02] })] }),
    )
    expect(problemas).toContain('task T01 referencia fase inexistente')
    expect(problemas).toContain('task T01 depende de T02 inexistente')
  })

  it('missao consistente nao acusa nada', () => {
    expect(checkMissionSpecInvariants(spec())).toEqual([])
  })
})
