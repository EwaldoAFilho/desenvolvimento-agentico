import { describe, expect, it } from 'vitest'
import { compileInput } from './__fixtures__/builders.js'
import { REAL_GATES_YAML } from './__fixtures__/real-gates.js'
import { REAL_MISSION_YAML } from './__fixtures__/real-mission.js'
import { REAL_PROJECT_YAML } from './__fixtures__/real-project.js'
import { compileMission } from './compile.js'
import { codesOf } from './diagnostics.js'
import type { CompileInput, CompileResult } from './types.js'

const REAL: CompileInput = {
  missionText: REAL_MISSION_YAML,
  projectFile: REAL_PROJECT_YAML,
  gatesFile: REAL_GATES_YAML,
}

/** Plano com problema de cada severidade, para que a ordenacao tenha o que ordenar. */
const NOISY = compileInput({
  mission: {
    phases: [{ id: 'alpha' }, { id: 'beta' }],
    tasks: [
      { id: 'T01', touches: ['scripts/'] },
      { id: 'T02', dependencies: ['T01'], touches: ['packages/shared/'] },
      { id: 'T03', dependencies: ['T01'], touches: ['packages/shared/'] },
      { id: 'T04', phase: 'beta', dependencies: ['T02', 'T03'], gate: 'mission' },
      { id: 'T05', dependencies: ['T01'], risk: 'high', requireReview: false },
      { id: 'T06', phase: 'beta', dependencies: ['T04'], gate: 'mission' },
    ],
  },
})

function thrice(input: CompileInput): CompileResult[] {
  return [compileMission(input), compileMission(input), compileMission(input)]
}

describe('determinismo', () => {
  it('compila a missao real tres vezes com o mesmo resultado', () => {
    const [first, second, third] = thrice(REAL)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(first?.graph?.specHash).toBe(third?.graph?.specHash)
  })

  it('mantem a mesma ordem de diagnosticos em execucoes repetidas', () => {
    const runs = thrice(NOISY).map((result) => codesOf(result.diagnostics))
    expect(runs[1]).toEqual(runs[0])
    expect(runs[2]).toEqual(runs[0])
  })

  it('ordena ERROR, WARNING e INFO nessa ordem, com codigos agrupados', () => {
    const result = compileMission(NOISY)
    expect(codesOf(result.diagnostics)).toEqual(['DA2001', 'DA2005', 'DA2006', 'DA2007', 'DA3001'])
    expect(result.diagnostics.map((item) => item.severity)).toEqual([
      'WARNING',
      'WARNING',
      'WARNING',
      'WARNING',
      'INFO',
    ])
  })

  it('serializa o grafo de forma estavel entre execucoes', () => {
    const [first, second] = thrice(REAL)
    expect(JSON.stringify(second?.graph)).toBe(JSON.stringify(first?.graph))
  })

  it('nao depende da instancia de entrada: texto igual, resultado igual', () => {
    const copy: CompileInput = {
      missionText: `${REAL_MISSION_YAML}`,
      projectFile: `${REAL_PROJECT_YAML}`,
      gatesFile: `${REAL_GATES_YAML}`,
    }
    expect(compileMission(copy)).toEqual(compileMission(REAL))
  })
})
