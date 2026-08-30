import { describe, expect, it } from 'vitest'
import { compileInput, missionYaml } from './__fixtures__/builders.js'
import { compileMission } from './compile.js'
import { canonicalJson, fnv1a64 } from './hash.js'

/** Mesma missao, escrita de dois jeitos: ordem de chaves, quebra de linha e comentario. */
const MISSION_A = `apiVersion: agentic/v1
kind: Mission
id: DA-HASH-001
title: Missao de hash
objective: Verificar estabilidade do specHash.
acceptanceCriteria:
  - O hash ignora formatacao
phases:
  - id: alpha
    title: Alpha
tasks:
  - id: T01
    phase: alpha
    title: Primeira
    objective: >
      Entrega a primeira parte
      do trabalho.
    dependencies: []
    touches:
      - packages/a/
    gate: unit
    risk: low
    estimate: 2
  - id: T02
    phase: alpha
    title: Segunda
    objective: Entrega a segunda parte do trabalho.
    dependencies: [T01]
    touches:
      - packages/b/
    gate: mission
    risk: low
    estimate: 3
missionGate: mission
`

const MISSION_B = `apiVersion: agentic/v1
kind: Mission

# Comentario nao e conteudo: o hash nao pode enxerga-lo.
title: Missao de hash
id: DA-HASH-001
acceptanceCriteria:
  - O hash ignora formatacao
objective: Verificar estabilidade do specHash.
phases:
  - title: Alpha
    id: alpha
tasks:
  - id: T01
    title: Primeira
    phase: alpha
    estimate: 2
    risk: low
    gate: unit
    touches: [packages/a/]
    dependencies: []
    objective: Entrega a primeira parte do trabalho.
  - id: T02
    title: Segunda
    phase: alpha
    estimate: 3
    risk: low
    gate: mission
    touches: [packages/b/]
    dependencies: [T01]
    objective: Entrega a segunda parte do trabalho.
missionGate: mission
`

function hashOf(missionText: string): string {
  const result = compileMission({ ...compileInput(), missionText })
  if (result.graph === undefined) {
    throw new Error(`missao nao compilou: ${JSON.stringify(result.diagnostics)}`)
  }
  return result.graph.specHash
}

describe('fnv1a64', () => {
  it('e deterministico e cabe em 16 hexadecimais', () => {
    expect(fnv1a64('agentic')).toBe(fnv1a64('agentic'))
    expect(fnv1a64('agentic')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('separa entradas diferentes, inclusive por um caractere', () => {
    expect(fnv1a64('T01')).not.toBe(fnv1a64('T02'))
    expect(fnv1a64('')).not.toBe(fnv1a64(' '))
  })
})

describe('canonicalJson', () => {
  it('ordena chaves e ignora campos indefinidos', () => {
    expect(canonicalJson({ b: 1, a: 2, c: undefined })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }))
  })

  it('preserva a ordem de array, que e semantica', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })
})

describe('specHash', () => {
  it('e estavel entre execucoes', () => {
    expect(hashOf(MISSION_A)).toBe(hashOf(MISSION_A))
    expect(hashOf(MISSION_A)).toMatch(/^fnv1a64:[0-9a-f]{16}$/)
  })

  it('nao muda com reordenacao de chaves, comentario ou requebra de bloco', () => {
    expect(hashOf(MISSION_B)).toBe(hashOf(MISSION_A))
  })

  it('muda quando o estimate muda', () => {
    expect(hashOf(MISSION_A.replace('estimate: 3', 'estimate: 5'))).not.toBe(hashOf(MISSION_A))
  })

  it('muda quando o objetivo muda', () => {
    const changed = MISSION_A.replace('Entrega a segunda parte', 'Entrega outra parte')
    expect(hashOf(changed)).not.toBe(hashOf(MISSION_A))
  })

  it('muda quando o escopo de escrita muda', () => {
    expect(hashOf(MISSION_A.replace('packages/b/', 'packages/c/'))).not.toBe(hashOf(MISSION_A))
  })

  it('muda quando o gate muda', () => {
    const changed = MISSION_A.replace('    gate: unit', '    gate: mission')
    expect(hashOf(changed)).not.toBe(hashOf(MISSION_A))
  })

  it('nao muda com a ordem nem com a repeticao das dependencias', () => {
    const declared = missionYaml({
      tasks: [
        { id: 'T01' },
        { id: 'T02', dependencies: ['T01'] },
        { id: 'T03', dependencies: ['T01', 'T02'], gate: 'mission' },
      ],
    })
    const reordered = missionYaml({
      tasks: [
        { id: 'T01' },
        { id: 'T02', dependencies: ['T01'] },
        { id: 'T03', dependencies: ['T02', 'T01', 'T02'], gate: 'mission' },
      ],
    })
    expect(hashOf(reordered)).toBe(hashOf(declared))
  })

  it('nao depende do project.yaml: e hash da MissionSpec', () => {
    const other = compileInput({ project: { maxParallelTasks: 2 } })
    const result = compileMission({ ...other, missionText: MISSION_A })
    expect(result.graph?.specHash).toBe(hashOf(MISSION_A))
  })

  it('muda quando as tasks trocam de ordem, porque a ordem e o desempate do plano', () => {
    const declared = missionYaml({
      tasks: [
        { id: 'T01' },
        { id: 'T02', dependencies: ['T01'] },
        { id: 'T03', dependencies: ['T01'], gate: 'mission' },
      ],
    })
    const swapped = missionYaml({
      tasks: [
        { id: 'T01' },
        { id: 'T03', dependencies: ['T01'], gate: 'mission' },
        { id: 'T02', dependencies: ['T01'] },
      ],
    })
    expect(hashOf(swapped)).not.toBe(hashOf(declared))
  })
})
