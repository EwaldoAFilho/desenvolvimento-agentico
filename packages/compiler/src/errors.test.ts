import { describe, expect, it } from 'vitest'
import { compileInput, type InputDraft } from './__fixtures__/builders.js'
import { compileMission } from './compile.js'
import { codesOf } from './diagnostics.js'
import type { Diagnostic, DiagnosticCode } from './types.js'

const compile = (draft: InputDraft = {}) => compileMission(compileInput(draft))

function withCode(diagnostics: readonly Diagnostic[], code: DiagnosticCode): Diagnostic[] {
  return diagnostics.filter((item) => item.code === code)
}

function single(diagnostics: readonly Diagnostic[], code: DiagnosticCode): Diagnostic {
  const found = withCode(diagnostics, code)
  expect(found).toHaveLength(1)
  const first = found[0]
  if (first === undefined) throw new Error(`nenhum ${code} emitido`)
  return first
}

describe('base limpa', () => {
  it('compila sem nenhum diagnostico', () => {
    const result = compile()
    expect(result.diagnostics).toEqual([])
    expect(result.graph).toBeDefined()
  })
})

describe('DA1000 — YAML invalido', () => {
  it('recusa o arquivo e aponta a posicao', () => {
    const result = compile({ mission: 'apiVersion: agentic/v1\ntasks: [T01, T02\n' })
    const item = single(result.diagnostics, 'DA1000')
    expect(item.severity).toBe('ERROR')
    expect(item.targets).toEqual(['mission'])
    expect(item.line).toBeGreaterThan(0)
    expect(result.graph).toBeUndefined()
  })

  it('vale para project.yaml e gates.yaml tambem', () => {
    const result = compile({ project: 'execution: [\n', gates: 'profiles: {\n' })
    expect(
      withCode(result.diagnostics, 'DA1000')
        .map((item) => item.targets[0])
        .sort(),
    ).toEqual(['gates', 'project'])
  })
})

describe('DA1001 — falha de schema', () => {
  it('aponta o campo com id fora do formato', () => {
    const result = compile({ mission: { tasks: [{ id: 'T1' }] } })
    const item = single(result.diagnostics, 'DA1001')
    expect(item.severity).toBe('ERROR')
    expect(item.targets).toEqual(['mission.tasks[0].id'])
    expect(item.line).toBeGreaterThan(0)
    expect(result.graph).toBeUndefined()
  })

  it('recusa apiVersion desconhecida em vez de adivinhar', () => {
    const mission = compileInput().missionText.replace('agentic/v1', 'agentic/v9')
    const result = compile({ mission })
    expect(codesOf(result.diagnostics)).toContain('DA1001')
  })
})

describe('DA1002 — TaskId duplicado', () => {
  it('cita a task declarada duas vezes', () => {
    const result = compile({
      mission: { tasks: [{ id: 'T01' }, { id: 'T01', touches: ['packages/outro/'] }] },
    })
    const item = single(result.diagnostics, 'DA1002')
    expect(item.severity).toBe('ERROR')
    expect(item.targets).toEqual(['T01'])
  })
})

describe('DA1003 — dependencia inexistente', () => {
  it('cita a task e o id ausente', () => {
    const result = compile({
      mission: { tasks: [{ id: 'T01' }, { id: 'T02', dependencies: ['T99'] }] },
    })
    const item = single(result.diagnostics, 'DA1003')
    expect(item.severity).toBe('ERROR')
    expect(item.targets).toEqual(['T02', 'T99'])
  })
})

describe('DA1004 — auto-dependencia', () => {
  it('cita a task que espera por si mesma', () => {
    const result = compile({ mission: { tasks: [{ id: 'T01', dependencies: ['T01'] }] } })
    const item = single(result.diagnostics, 'DA1004')
    expect(item.severity).toBe('ERROR')
    expect(item.targets).toEqual(['T01'])
    expect(withCode(result.diagnostics, 'DA1005')).toEqual([])
  })
})

describe('DA1005 — ciclo', () => {
  it('lista o ciclo completo, nao apenas a existencia dele', () => {
    const result = compile({
      mission: {
        tasks: [
          { id: 'T01', dependencies: ['T03'] },
          { id: 'T02', dependencies: ['T01'] },
          { id: 'T03', dependencies: ['T02'] },
        ],
      },
    })
    const item = single(result.diagnostics, 'DA1005')
    expect(item.severity).toBe('ERROR')
    expect(item.message).toContain('T01 → T02 → T03 → T01')
    expect(item.targets).toEqual(['T01', 'T02', 'T03'])
    expect(result.graph).toBeUndefined()
  })
})

describe('DA1006 — phase nao declarada', () => {
  it('cita a task e a fase inexistente', () => {
    const result = compile({ mission: { tasks: [{ id: 'T01', phase: 'omega' }] } })
    const item = single(result.diagnostics, 'DA1006')
    expect(item.severity).toBe('ERROR')
    expect(item.targets).toEqual(['T01', 'omega'])
  })
})

describe('DA1007 — gate inexistente', () => {
  it('cita a task e o perfil ausente em gates.yaml', () => {
    const result = compile({ mission: { tasks: [{ id: 'T01', gate: 'inexistente' }] } })
    const item = single(result.diagnostics, 'DA1007')
    expect(item.severity).toBe('ERROR')
    expect(item.targets).toEqual(['T01', 'inexistente'])
  })

  it('vale tambem para o mission gate', () => {
    const result = compile({
      mission: { tasks: [{ id: 'T01', gate: 'unit' }], missionGate: 'ausente' },
    })
    const item = single(result.diagnostics, 'DA1007')
    expect(item.targets).toEqual(['DA-TEST-001', 'ausente'])
  })
})

describe('DA1008 — touches invalido', () => {
  it('recusa task sem escopo de escrita', () => {
    const result = compile({ mission: { tasks: [{ id: 'T01', touches: [] }] } })
    const item = single(result.diagnostics, 'DA1008')
    expect(item.severity).toBe('ERROR')
    expect(item.targets).toEqual(['T01'])
  })

  it('recusa escopo dentro de denyPaths', () => {
    const result = compile({ mission: { tasks: [{ id: 'T01', touches: ['.agentic/runs/'] }] } })
    const item = single(result.diagnostics, 'DA1008')
    expect(item.targets).toEqual(['T01', '.agentic/runs/'])
    expect(item.message).toContain('.agentic/')
  })

  it('recusa escopo negado por glob', () => {
    const result = compile({ mission: { tasks: [{ id: 'T01', touches: ['certs/server.pem'] }] } })
    const item = single(result.diagnostics, 'DA1008')
    expect(item.targets).toEqual(['T01', 'certs/server.pem'])
  })
})

describe('DA1009 — objective vazio', () => {
  it('recusa objetivo sem conteudo em task que altera codigo', () => {
    const result = compile({
      mission: { tasks: [{ id: 'T01', objective: '...', touches: ['packages/a/'] }] },
    })
    const item = single(result.diagnostics, 'DA1009')
    expect(item.severity).toBe('ERROR')
    expect(item.targets).toEqual(['T01'])
  })
})

describe('DA1010 — paralelismo com workspace shared', () => {
  it('recusa maxParallelTasks maior que 1 em workspace compartilhado', () => {
    const result = compile({ project: { workspace: 'shared', maxParallelTasks: 3 } })
    const item = single(result.diagnostics, 'DA1010')
    expect(item.severity).toBe('ERROR')
    expect(item.targets).toEqual(['project.execution.maxParallelTasks'])
    expect(item.line).toBeGreaterThan(0)
  })

  it('aceita workspace compartilhado com uma task por vez', () => {
    const result = compile({ project: { workspace: 'shared', maxParallelTasks: 1 } })
    expect(codesOf(result.diagnostics)).not.toContain('DA1010')
  })
})

describe('DA1011 — perfil ou provider inexistente', () => {
  it('cita a task e o perfil ausente no registry', () => {
    const result = compile({ mission: { tasks: [{ id: 'T01', agentProfile: 'fantasma' }] } })
    const item = single(result.diagnostics, 'DA1011')
    expect(item.severity).toBe('ERROR')
    expect(item.targets).toEqual(['T01', 'fantasma'])
  })

  it('cita o provider default fora do registry', () => {
    const result = compile({ project: { defaultProvider: 'ausente' } })
    const item = single(result.diagnostics, 'DA1011')
    expect(item.targets).toEqual(['project.providers.default', 'ausente'])
  })
})

describe('postura diante de ERROR', () => {
  it('nao produz grafo e nao mistura heuristica com erro estrutural', () => {
    const result = compile({ mission: { tasks: [{ id: 'T01', dependencies: ['T99'] }] } })
    expect(result.graph).toBeUndefined()
    expect(codesOf(result.diagnostics)).toEqual(['DA1003'])
  })

  it('nunca lanca, mesmo com entrada que nao e YAML de missao', () => {
    expect(() =>
      compileMission({ missionText: ' ', projectFile: '', gatesFile: '[]' }),
    ).not.toThrow()
    const result = compileMission({ missionText: '', projectFile: '', gatesFile: '' })
    expect(result.graph).toBeUndefined()
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })
})
