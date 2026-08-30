import { describe, expect, it } from 'vitest'
import {
  GATE_ALWAYS_PASS,
  gatesYaml,
  missionYaml,
  projectYaml,
} from '../engine/__fixtures__/files.js'
import { compileMission, UNKNOWN_MISSION, validateMission } from './compile.js'

const gatesText = gatesYaml({ unit: [GATE_ALWAYS_PASS] })
const projectText = projectYaml()

const missionText = missionYaml({
  defaultGate: 'unit',
  missionGate: 'unit',
  tasks: [
    { id: 'T01' },
    { id: 'T02', dependencies: ['T01'] },
    { id: 'T03', dependencies: ['T01'] },
  ],
})

describe('ValidateMission', () => {
  it('aprova missao consistente e descreve o plano', () => {
    const report = validateMission({ missionText, projectFile: projectText, gatesFile: gatesText })
    expect(report.ok).toBe(true)
    expect(report.missionId).toBe('DA-TEST-001')
    expect(report.stats.tasks).toBe(3)
    expect(report.stats.edges).toBe(2)
    expect(report.stats.errors).toBe(0)
    expect(report.stats.criticalPathLength).toBeGreaterThan(0)
    expect(report.stats.maxParallelism).toBe(2)
    expect(report.specHash).toContain('fnv1a64:')
  })

  it('recusa dependencia inexistente com codigo do catalogo', () => {
    const broken = missionYaml({
      defaultGate: 'unit',
      tasks: [{ id: 'T01', dependencies: ['T99'] }],
    })
    const report = validateMission({
      missionText: broken,
      projectFile: projectText,
      gatesFile: gatesText,
    })
    expect(report.ok).toBe(false)
    expect(report.stats.errors).toBeGreaterThan(0)
    expect(report.diagnostics.map((item) => item.code)).toContain('DA1003')
    expect(report.missionId).toBe('DA-TEST-001')
  })

  it('devolve id desconhecido quando nem o cabecalho e legivel', () => {
    const report = validateMission({
      missionText: ':::: nao e yaml valido\n  - [',
      projectFile: projectText,
      gatesFile: gatesText,
    })
    expect(report.ok).toBe(false)
    expect(report.missionId).toBe(UNKNOWN_MISSION)
    expect(report.stats.tasks).toBe(0)
  })

  it('sinaliza WARNING sem impedir a compilacao', () => {
    const noGate = missionYaml({
      defaultGate: null,
      tasks: [{ id: 'T01', gate: null, validation: [] }],
    })
    const report = validateMission({
      missionText: noGate,
      projectFile: projectText,
      gatesFile: gatesText,
    })
    expect(report.ok).toBe(true)
    expect(report.stats.warnings).toBeGreaterThan(0)
  })
})

describe('CompileMission', () => {
  it('produz grafo congelavel com ordem topologica', () => {
    const result = compileMission({
      missionText,
      projectFile: projectText,
      gatesFile: gatesText,
    })
    expect(result.graph?.topologicalOrder).toEqual(['T01', 'T02', 'T03'])
    expect(result.graph?.nodes).toHaveLength(3)
  })

  it('nao lanca diante de arquivo invalido', () => {
    const result = compileMission({ missionText: '', projectFile: '', gatesFile: '' })
    expect(result.graph).toBeUndefined()
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })
})
