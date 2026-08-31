import type { MissionSpec, TaskSpec } from '@agentic/domain'
import {
  missionFileFromPlan,
  parseMissionFile,
  parseMissionPlan,
  toMissionSpec,
} from '@agentic/schemas'
import { describe, expect, it } from 'vitest'
import { canonicalMissionSpec, missionFileOf, missionYamlOf, renderYaml } from './mission-yaml.js'

/** O MESMO caminho do adapter de planejamento: plano -> contrato -> `MissionSpec`. */
function specOf(plan: Record<string, unknown>): MissionSpec {
  const parsed = parseMissionPlan(JSON.stringify(plan))
  if (!parsed.ok) throw new Error(`plano invalido no teste: ${JSON.stringify(parsed.issues)}`)
  return toMissionSpec(missionFileFromPlan(parsed.value))
}

function planOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'DA-YML-001',
    title: 'missao proposta por um planejador',
    objective: 'provar que o control plane grava o que foi proposto',
    acceptanceCriteria: ['o arquivo gravado compila'],
    defaults: { requireReview: true, maxAttempts: 3, gate: 'unit' },
    phases: [{ id: 'build', title: 'Build' }],
    tasks: [
      {
        id: 'T01',
        phase: 'build',
        title: 'primeira entrega',
        objective: 'entregar T01 com prova',
        dependencies: [],
        touches: ['packages/t01/'],
        validation: ['o gate da task passa'],
        risk: 'low',
        estimate: 1,
      },
    ],
    ...overrides,
  }
}

function textOf(spec: MissionSpec, header: readonly string[] = []): string {
  const result = missionYamlOf(spec, header)
  if (!result.ok) throw new Error(`serializacao recusada: ${JSON.stringify(result.problems)}`)
  return result.text
}

describe('o arquivo da missao e escrito pelo control plane', () => {
  it('declara a versao do formato, que o planejador nunca escolhe', () => {
    const spec = specOf(planOf())
    const file = missionFileOf(spec)

    expect(file.apiVersion).toBe('agentic/v1')
    expect(file.kind).toBe('Mission')
    // A proposta nao tem esses dois campos: o contrato do plano os omite de proposito.
    expect(Object.keys(planOf())).not.toContain('apiVersion')
  })

  it('o texto gravado volta a ser exatamente o MissionSpec proposto', () => {
    const spec = specOf(planOf())
    const parsed = parseMissionFile(textOf(spec))

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(canonicalMissionSpec(toMissionSpec(parsed.value))).toBe(canonicalMissionSpec(spec))
  })

  it('prosa com dois-pontos, cerquilha, traco e aspas nao muda de sentido', () => {
    const hostil = 'nota: #1 - "aspas", \\barra e quebra\nde linha'
    const spec = specOf(
      planOf({
        title: hostil,
        constraints: ['- item que parece lista', 'yes', '123', '*.pem fica de fora'],
      }),
    )
    const parsed = parseMissionFile(textOf(spec))

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const reread = toMissionSpec(parsed.value)
    expect(reread.title).toBe(hostil)
    // `yes` e `123` continuam texto, nao viram booleano nem numero.
    expect(reread.constraints).toEqual([
      '- item que parece lista',
      'yes',
      '123',
      '*.pem fica de fora',
    ])
  })

  it('a heranca de defaults vira valor explicito na task, com o mesmo significado', () => {
    const spec = specOf(planOf())
    const text = textOf(spec)

    // `gate` e `requireReview` nao estavam na task proposta: vieram de `defaults`.
    expect(text).toContain('gate: "unit"')
    expect(text).toContain('requireReview: true')
    const parsed = parseMissionFile(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(canonicalMissionSpec(toMissionSpec(parsed.value))).toBe(canonicalMissionSpec(spec))
  })

  it('o cabecalho e comentario: explica a origem sem entrar no plano', () => {
    const spec = specOf(planOf())
    const text = textOf(spec, ['gravado pelo control plane', 'rascunho, nada aprovado'])

    expect(text.startsWith('# gravado pelo control plane\n')).toBe(true)
    const parsed = parseMissionFile(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(canonicalMissionSpec(toMissionSpec(parsed.value))).toBe(canonicalMissionSpec(spec))
  })

  it('plano que nao sobrevive a ida e volta e recusado, nao gravado pela metade', () => {
    const spec = specOf(planOf())
    const first = spec.tasks[0] as TaskSpec
    // `estimate` ausente: a releitura aplicaria o default do schema e o arquivo passaria a
    // dizer algo que a proposta nao dizia. Preferimos recusar.
    const mutilado: MissionSpec = {
      ...spec,
      tasks: [{ ...first, estimate: undefined }],
    }
    const result = missionYamlOf(mutilado)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]?.message).toContain('ida e volta')
  })
})

describe('forma canonica', () => {
  it('ignora a ordem das chaves e enxerga a ordem das tasks', () => {
    const spec = specOf(planOf())
    const reordenado = Object.fromEntries(Object.entries(spec).reverse()) as unknown as MissionSpec
    expect(canonicalMissionSpec(reordenado)).toBe(canonicalMissionSpec(spec))

    const outraOrdem = specOf(
      planOf({
        tasks: [
          {
            id: 'T02',
            phase: 'build',
            title: 'segunda entrega',
            objective: 'entregar T02 com prova',
            dependencies: [],
            touches: ['packages/t02/'],
            validation: ['o gate da task passa'],
            risk: 'low',
            estimate: 1,
          },
        ],
      }),
    )
    expect(canonicalMissionSpec(outraOrdem)).not.toBe(canonicalMissionSpec(spec))
  })
})

describe('renderYaml', () => {
  it('bloco vazio sai inline e nao vira chave pendurada', () => {
    expect(renderYaml({ lista: [], mapa: {}, texto: 'ok' })).toBe(
      'lista: []\nmapa: {}\ntexto: "ok"\n',
    )
  })

  it('objeto dentro de lista alinha sob a primeira chave', () => {
    expect(renderYaml({ itens: [{ a: 1, b: [2] }] })).toBe('itens:\n  - a: 1\n    b:\n      - 2\n')
  })

  it('chave undefined nao aparece no documento', () => {
    expect(renderYaml({ presente: 'sim', ausente: undefined })).toBe('presente: "sim"\n')
  })
})
