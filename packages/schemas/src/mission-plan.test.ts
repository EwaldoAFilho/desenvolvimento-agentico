import { describe, expect, it } from 'vitest'
import { API_VERSION } from './common.js'
import { issuesOf } from './issues.js'
import {
  canonicalMissionPlan,
  type MissionPlan,
  MissionPlanSchema,
  missionFileFromPlan,
  planProblemLines,
  planProblemsOf,
} from './mission-plan.js'
import { parseMissionPlan } from './parse.js'

const task: MissionPlan['tasks'][number] = {
  id: 'T01',
  phase: 'core',
  title: 'Somar saldo',
  objective: 'agregar por deposito',
  dependencies: [],
  touches: ['src/estoque.js'],
  risk: 'low',
  estimate: 1,
}

const plan: MissionPlan = {
  id: 'DA-EXEMPLO-002',
  title: 'Relatorio de estoque',
  objective: 'somar saldo por deposito',
  acceptanceCriteria: ['o relatorio soma por deposito'],
  phases: [{ id: 'core', title: 'Nucleo' }],
  tasks: [task],
}

describe('MissionPlanSchema — o planejador propoe conteudo, nunca formato', () => {
  it('aceita o plano sem `apiVersion` nem `kind`', () => {
    expect(MissionPlanSchema.safeParse(plan).success).toBe(true)
  })

  it('recusa a proposta que tenta declarar a versao do formato', () => {
    expect(MissionPlanSchema.safeParse({ ...plan, apiVersion: 'agentic/v99' }).success).toBe(false)
  })

  it('recusa campo desconhecido: o contrato e fechado, nao um saco de chaves', () => {
    expect(MissionPlanSchema.safeParse({ ...plan, prioridade: 'alta' }).success).toBe(false)
  })

  it('a versao entra na hora de fechar o documento, vinda de nos', () => {
    const file = missionFileFromPlan(plan)

    expect(file.apiVersion).toBe(API_VERSION)
    expect(file.kind).toBe('Mission')
    expect(file.id).toBe('DA-EXEMPLO-002')
  })
})

describe('proposta invalida e recusada com motivo legivel', () => {
  it('objetivo vazio aponta o caminho exato dentro da proposta', () => {
    const result = parseMissionPlan(
      JSON.stringify({ ...plan, tasks: [{ ...task, objective: '' }] }),
    )

    expect(result.ok).toBe(false)
    const problems = planProblemsOf(issuesOf(result))
    expect(problems.map((problem) => problem.path)).toContain('tasks[0].objective')
    expect(planProblemLines(problems).join('\n')).toContain('tasks[0].objective:')
  })

  it('missao sem task nenhuma nao vira plano parcial: e recusa', () => {
    const result = parseMissionPlan(JSON.stringify({ ...plan, tasks: [] }))

    expect(result.ok).toBe(false)
    expect(planProblemLines(planProblemsOf(issuesOf(result)))).not.toHaveLength(0)
  })

  it('id de missao fora do padrao diz qual e o padrao, nao apenas "invalido"', () => {
    const result = parseMissionPlan(JSON.stringify({ ...plan, id: 'plano legal' }))

    expect(result.ok).toBe(false)
    expect(planProblemLines(planProblemsOf(issuesOf(result))).join('\n')).toContain('MissionId')
  })

  it('saida que nem chega a ser um documento e recusada sem lancar', () => {
    const result = parseMissionPlan('desculpe, nao consegui planejar isso')

    expect(result.ok).toBe(false)
    expect(issuesOf(result).length).toBeGreaterThan(0)
  })

  it('problema sem caminho sai sem prefixo orfao', () => {
    expect(planProblemLines([{ path: '', message: 'plano vazio' }])).toEqual(['plano vazio'])
  })
})

describe('JSON e YAML entram pelo mesmo caminho', () => {
  it('a saida estruturada em JSON e aceita', () => {
    const result = parseMissionPlan(JSON.stringify(plan))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.tasks).toHaveLength(1)
  })

  it('o mesmo plano em YAML produz o mesmo valor', () => {
    const yaml = [
      'id: DA-EXEMPLO-002',
      'title: Relatorio de estoque',
      'objective: somar saldo por deposito',
      'acceptanceCriteria:',
      '  - o relatorio soma por deposito',
      'phases:',
      '  - id: core',
      '    title: Nucleo',
      'tasks:',
      '  - id: T01',
      '    phase: core',
      '    title: Somar saldo',
      '    objective: agregar por deposito',
      '    dependencies: []',
      '    touches:',
      '      - src/estoque.js',
      '    risk: low',
      '    estimate: 1',
    ].join('\n')

    const result = parseMissionPlan(yaml)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(canonicalMissionPlan(result.value)).toBe(canonicalMissionPlan(plan))
  })
})

describe('identidade semantica interrompe o ciclo de reparo', () => {
  it('mesma proposta com chaves em outra ordem tem a mesma forma canonica', () => {
    const reordenado: MissionPlan = {
      tasks: plan.tasks,
      phases: plan.phases,
      acceptanceCriteria: plan.acceptanceCriteria,
      objective: plan.objective,
      title: plan.title,
      id: plan.id,
    }

    expect(canonicalMissionPlan(reordenado)).toBe(canonicalMissionPlan(plan))
  })

  it('campo ausente e campo `undefined` nao sao propostas diferentes', () => {
    expect(canonicalMissionPlan({ ...plan, description: undefined })).toBe(
      canonicalMissionPlan(plan),
    )
  })

  it('mudanca real de conteudo muda a forma canonica', () => {
    expect(canonicalMissionPlan({ ...plan, objective: 'somar saldo por filial' })).not.toBe(
      canonicalMissionPlan(plan),
    )
  })

  it('ordem de task e significativa: reordenar muda o plano que o humano vai ler', () => {
    const segunda = { ...task, id: 'T02', dependencies: ['T01'] }
    const duas: MissionPlan = { ...plan, tasks: [task, segunda] }
    const invertido: MissionPlan = { ...plan, tasks: [segunda, task] }

    expect(canonicalMissionPlan(invertido)).not.toBe(canonicalMissionPlan(duas))
  })
})
