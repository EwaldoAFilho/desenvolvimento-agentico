import { checkMissionSpecInvariants } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import { REAL_GATES_YAML } from './__fixtures__/real-gates.js'
import { REAL_MISSION_YAML } from './__fixtures__/real-mission.js'
import { REAL_PROJECT_YAML } from './__fixtures__/real-project.js'
import { issuesOf } from './issues.js'
import { parseGatesFile, parseMissionFile, parseProjectFile } from './parse.js'
import { toMissionSpec } from './to-domain.js'

/** Se os arquivos reais do proprio projeto nao validam, o schema esta errado — nao eles. */
describe('arquivos reais de .agentic', () => {
  it('project.yaml parseia', () => {
    const result = parseProjectFile(REAL_PROJECT_YAML)
    expect(issuesOf(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('gates.yaml parseia', () => {
    const result = parseGatesFile(REAL_GATES_YAML)
    expect(issuesOf(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('DA-CORE-001.mission.yaml parseia', () => {
    const result = parseMissionFile(REAL_MISSION_YAML)
    expect(issuesOf(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('a missao tem 17 tasks e 7 fases', () => {
    const result = parseMissionFile(REAL_MISSION_YAML)
    if (!result.ok) throw new Error('missao real deveria parsear')
    expect(result.value.tasks).toHaveLength(17)
    expect(result.value.phases).toHaveLength(7)
    expect(result.value.id).toBe('DA-CORE-001')
    expect(result.value.missionGate).toBe('mission')
  })

  it('a missao real vira MissionSpec sem violar invariante de dominio', () => {
    const result = parseMissionFile(REAL_MISSION_YAML)
    if (!result.ok) throw new Error('missao real deveria parsear')
    const spec = toMissionSpec(result.value)
    expect(spec.tasks).toHaveLength(17)
    expect(checkMissionSpecInvariants(spec)).toEqual([])
  })

  it('o registry do projeto declara capacidade por fornecedor', () => {
    const result = parseProjectFile(REAL_PROJECT_YAML)
    if (!result.ok) throw new Error('project real deveria parsear')
    const registry = result.value.providers.registry
    expect(Object.keys(registry)).toHaveLength(3)
    for (const config of Object.values(registry)) {
      expect(config.maxConcurrent).toBeGreaterThan(0)
      expect(config.roles.length).toBeGreaterThan(0)
    }
  })

  it('o projeto real resolve politica de revisao por risco', () => {
    const result = parseProjectFile(REAL_PROJECT_YAML)
    if (!result.ok) throw new Error('project real deveria parsear')
    expect(result.value.policies.review.byRisk).toEqual({
      low: 'fresh-session',
      medium: 'cross-provider-preferred',
      high: 'cross-provider-required',
    })
  })

  it('o projeto real declara workspaceSetup', () => {
    const result = parseProjectFile(REAL_PROJECT_YAML)
    if (!result.ok) throw new Error('project real deveria parsear')
    expect(result.value.execution.workspaceSetup.link).toEqual(['node_modules'])
    expect(result.value.execution.workspaceSetup.timeoutMs).toBe(600_000)
  })

  it('gates.yaml real expoe os perfis usados pela missao', () => {
    const result = parseGatesFile(REAL_GATES_YAML)
    if (!result.ok) throw new Error('gates real deveria parsear')
    expect(Object.keys(result.value.profiles).sort()).toEqual(['mission', 'unit', 'web'])
    expect(result.value.env.allow).toContain('PATH')
  })

  it('todo gate citado pela missao real existe em gates.yaml', () => {
    const mission = parseMissionFile(REAL_MISSION_YAML)
    const gates = parseGatesFile(REAL_GATES_YAML)
    if (!mission.ok || !gates.ok) throw new Error('fixtures reais deveriam parsear')
    const profiles = new Set(Object.keys(gates.value.profiles))
    const spec = toMissionSpec(mission.value)
    for (const task of spec.tasks) {
      expect(profiles.has(String(task.gate))).toBe(true)
    }
  })
})
