import { checkMissionSpecInvariants, resolveTaskSettings } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import { MINIMAL_MISSION_YAML, MISSION_WITH_DEFAULTS_YAML } from './__fixtures__/samples.js'
import type { MissionFile } from './mission-file.js'
import { parseMissionFile } from './parse.js'
import { toMissionSpec } from './to-domain.js'

function missionFile(text: string): MissionFile {
  const result = parseMissionFile(text)
  if (!result.ok) throw new Error(`fixture invalida: ${JSON.stringify(result.issues)}`)
  return result.value
}

const withDefaults = () => toMissionSpec(missionFile(MISSION_WITH_DEFAULTS_YAML))
const minimal = () => toMissionSpec(missionFile(MINIMAL_MISSION_YAML))

describe('toMissionSpec — identidade e ids nominais', () => {
  it('constroi os ids do dominio', () => {
    const spec = minimal()
    expect(spec.id).toBe('DA-TEST-001')
    expect(spec.phases[0]?.id).toBe('core')
    expect(spec.tasks[0]?.id).toBe('T01')
    expect(spec.tasks[0]?.phase).toBe('core')
  })

  it('normaliza touches e reads como PathScope', () => {
    const spec = toMissionSpec(
      missionFile(MINIMAL_MISSION_YAML.replace('packages/exemplo/', './packages//exemplo/')),
    )
    expect(spec.tasks[0]?.touches).toEqual(['packages/exemplo/'])
  })

  it('normaliza listas ausentes para vazio', () => {
    const spec = minimal()
    expect(spec.scope).toEqual([])
    expect(spec.outOfScope).toEqual([])
    expect(spec.constraints).toEqual([])
    expect(spec.tasks[0]?.validation).toEqual([])
    expect(spec.tasks[0]?.dependencies).toEqual([])
    expect(spec.tasks[0]?.touches).toEqual(['packages/exemplo/'])
  })

  it('produz um MissionSpec que satisfaz os invariantes do dominio', () => {
    expect(checkMissionSpecInvariants(withDefaults())).toEqual([])
    expect(checkMissionSpecInvariants(minimal())).toEqual([])
  })

  it('mantem missionGate e defaults da missao', () => {
    const spec = withDefaults()
    expect(spec.missionGate).toBe('mission')
    expect(spec.defaults).toEqual({
      requireReview: true,
      maxAttempts: 4,
      gate: 'unit',
      agentProfile: 'executor',
      reviewPolicy: 'cross-provider-preferred',
    })
  })
})

describe('toMissionSpec — heranca de defaults, campo a campo', () => {
  it('herda gate', () => {
    const [herda, sobrescreve] = withDefaults().tasks
    expect(herda?.gate).toBe('unit')
    expect(sobrescreve?.gate).toBe('web')
  })

  it('herda requireReview', () => {
    const [herda, sobrescreve] = withDefaults().tasks
    expect(herda?.requireReview).toBe(true)
    expect(sobrescreve?.requireReview).toBe(false)
  })

  it('herda maxAttempts', () => {
    const [herda, sobrescreve] = withDefaults().tasks
    expect(herda?.maxAttempts).toBe(4)
    expect(sobrescreve?.maxAttempts).toBe(1)
  })

  it('herda agentProfile', () => {
    const [herda, sobrescreve] = withDefaults().tasks
    expect(herda?.agentProfile).toBe('executor')
    expect(sobrescreve?.agentProfile).toBe('revisor')
  })

  it('herda reviewPolicy', () => {
    const [herda, sobrescreve] = withDefaults().tasks
    expect(herda?.reviewPolicy).toBe('cross-provider-preferred')
    expect(sobrescreve?.reviewPolicy).toBe('cross-provider-required')
  })

  it('nao inventa valor quando nem task nem defaults declaram', () => {
    const task = minimal().tasks[0]
    expect(task?.gate).toBeUndefined()
    expect(task?.requireReview).toBeUndefined()
    expect(task?.maxAttempts).toBeUndefined()
    expect(task?.agentProfile).toBeUndefined()
    expect(task?.reviewPolicy).toBeUndefined()
  })

  it('deixa o ultimo fallback para o dominio, nao para a fronteira', () => {
    const spec = minimal()
    const task = spec.tasks[0]
    if (task === undefined) throw new Error('esperava uma task')
    expect(resolveTaskSettings(task, spec.defaults)).toEqual({
      requireReview: true,
      maxAttempts: 3,
      gate: undefined,
      agentProfile: undefined,
    })
  })

  it('preserva risk e estimate declarados e os defaults do schema', () => {
    const [herda, sobrescreve] = withDefaults().tasks
    expect(herda?.risk).toBe('medium')
    expect(herda?.estimate).toBe(1)
    expect(sobrescreve?.risk).toBe('high')
    expect(sobrescreve?.estimate).toBe(8)
  })

  it('preserva dependencies, reads e validation da task', () => {
    const sobrescreve = withDefaults().tasks[1]
    expect(sobrescreve?.dependencies).toEqual(['T01'])
    expect(sobrescreve?.reads).toEqual(['packages/um/'])
    expect(sobrescreve?.validation).toEqual(['Tem teste'])
  })

  it('missao sem bloco defaults produz defaults vazios', () => {
    expect(minimal().defaults).toEqual({})
  })
})
