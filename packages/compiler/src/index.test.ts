import { describe, expect, it } from 'vitest'
import { compileInput } from './__fixtures__/builders.js'
import * as compiler from './index.js'

/** A superficie publica e contrato para o scheduler, o orquestrador e as interfaces. */
describe('API publica de @agentic/compiler', () => {
  it('expoe o pipeline e as projecoes que os consumidores precisam', () => {
    for (const name of ['compileMission', 'toFrozenGraph', 'compiledTasks', 'totalWork']) {
      expect(typeof (compiler as Record<string, unknown>)[name]).toBe('function')
    }
    expect(compiler.PACKAGE_NAME).toBe('@agentic/compiler')
  })

  it('expoe o catalogo e os limiares das heuristicas', () => {
    expect(compiler.DIAGNOSTIC_CODES).toHaveLength(22)
    expect(Object.keys(compiler.DIAGNOSTIC_CATALOG)).toHaveLength(22)
    expect(compiler.HEURISTICS.minFragmentedChain).toBeGreaterThanOrEqual(3)
  })

  it('compila pela API publica e devolve grafo utilizavel', () => {
    const result = compiler.compileMission(compileInput())
    expect(result.graph).toBeDefined()
    expect(compiler.hasError(result.diagnostics)).toBe(false)
    expect(compiler.bySeverity(result.diagnostics, 'WARNING')).toEqual([])
  })

  it('formata alvo de campo com o arquivo de origem', () => {
    expect(compiler.fieldTarget('mission', ['tasks', 3, 'objective'])).toBe(
      'mission.tasks[3].objective',
    )
    expect(compiler.fieldTarget('project', [])).toBe('project')
  })

  it('acha um diagnostico pelo codigo', () => {
    const result = compiler.compileMission(
      compileInput({ mission: { tasks: [{ id: 'T01', touches: [] }] } }),
    )
    expect(compiler.findDiagnostic(result.diagnostics, 'DA1008')?.severity).toBe('ERROR')
    expect(compiler.findDiagnostic(result.diagnostics, 'DA2001')).toBeUndefined()
  })

  it('analisa uma missao ja compilada sem repetir o parse', () => {
    const result = compiler.compileMission(compileInput())
    const graph = result.graph
    if (graph === undefined) throw new Error('base limpa deveria compilar')
    expect(compiler.compiledTasks(graph)).toHaveLength(4)
    expect(compiler.toFrozenGraph(graph).tasks).toHaveLength(4)
    expect(compiler.totalWork(graph)).toBe(8)
  })
})
