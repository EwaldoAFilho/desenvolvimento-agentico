import { describe, expect, it } from 'vitest'
import {
  BASE_TASKS,
  compileInput,
  type InputDraft,
  type ProviderDraft,
} from './__fixtures__/builders.js'
import { compileMission } from './compile.js'
import { codesOf } from './diagnostics.js'
import { HEURISTICS } from './heuristics.js'
import type { Diagnostic, DiagnosticCode } from './types.js'

const compile = (draft: InputDraft = {}) => compileMission(compileInput(draft))

function single(diagnostics: readonly Diagnostic[], code: DiagnosticCode): Diagnostic {
  const found = diagnostics.filter((item) => item.code === code)
  expect(found).toHaveLength(1)
  const first = found[0]
  if (first === undefined) throw new Error(`nenhum ${code} emitido`)
  return first
}

const SINGLE_PROVIDER: Readonly<Record<string, ProviderDraft>> = {
  'alpha-cli': {
    kind: 'local-cli',
    command: 'alpha',
    maxConcurrent: 3,
    roles: ['executor', 'reviewer'],
    profiles: { executor: 'executor', reviewer: 'reviewer' },
  },
}

describe('DA2001 — conflito de touches entre concorrentes', () => {
  const result = compile({
    mission: {
      tasks: [
        { id: 'T01' },
        { id: 'T02', dependencies: ['T01'], touches: ['packages/shared/'] },
        { id: 'T03', dependencies: ['T01'], touches: ['packages/shared/'] },
        { id: 'T04', dependencies: ['T02', 'T03'], gate: 'mission' },
      ],
    },
  })

  it('cita o par e os caminhos sobrepostos', () => {
    const item = single(result.diagnostics, 'DA2001')
    expect(item.severity).toBe('WARNING')
    expect(item.targets).toEqual(['T02', 'T03'])
    expect(item.message).toContain('packages/shared/')
  })

  it('compila mesmo assim e registra o conflito no grafo', () => {
    expect(result.graph?.touchConflicts).toHaveLength(1)
    expect(result.graph?.touchConflicts[0]?.tasks).toEqual(['T02', 'T03'])
    expect(result.graph?.diagnostics).toEqual(result.diagnostics)
  })

  it('nao aponta conflito entre tasks com relacao de ordem', () => {
    const sequential = compile({
      mission: {
        tasks: [
          { id: 'T01', touches: ['packages/shared/'] },
          { id: 'T02', dependencies: ['T01'], touches: ['packages/shared/'], gate: 'mission' },
        ],
      },
    })
    expect(codesOf(sequential.diagnostics)).not.toContain('DA2001')
  })
})

describe('DA2002 — conclusao nao verificavel', () => {
  it('aponta a task sem gate e sem validation', () => {
    const result = compile({
      mission: {
        defaultsGate: null,
        tasks: [
          { id: 'T01' },
          { id: 'T02', dependencies: ['T01'], gate: null, validation: null },
          { id: 'T03', dependencies: ['T01'] },
          { id: 'T04', dependencies: ['T02', 'T03'], gate: 'mission' },
        ],
      },
    })
    const item = single(result.diagnostics, 'DA2002')
    expect(item.severity).toBe('WARNING')
    expect(item.targets).toEqual(['T02'])
  })
})

describe('DA2003 — task grande demais', () => {
  const wide = ['packages/a1/', 'packages/a2/', 'packages/a3/', 'packages/a4/', 'packages/a5/']
  const objective =
    'Reescreve a camada de acesso, ajusta os testes, atualiza os contratos, revisa a documentacao.'

  it('aponta escopo amplo somado a objetivo multi-clausula e estimate alto', () => {
    const result = compile({
      mission: {
        tasks: [
          { id: 'T01' },
          { id: 'T02', dependencies: ['T01'], touches: wide, objective, estimate: 9 },
          { id: 'T03', dependencies: ['T01'] },
          { id: 'T04', dependencies: ['T02', 'T03'], gate: 'mission' },
        ],
      },
    })
    const item = single(result.diagnostics, 'DA2003')
    expect(item.severity).toBe('WARNING')
    expect(item.targets).toEqual(['T02'])
  })

  it('nao aponta quando falta um dos tres sinais', () => {
    const result = compile({
      mission: {
        tasks: [
          { id: 'T01' },
          { id: 'T02', dependencies: ['T01'], touches: wide, objective, estimate: 2 },
          { id: 'T03', dependencies: ['T01'] },
          { id: 'T04', dependencies: ['T02', 'T03'], gate: 'mission' },
        ],
      },
    })
    expect(codesOf(result.diagnostics)).not.toContain('DA2003')
  })

  it('expoe os limiares em vez de esconde-los', () => {
    expect(HEURISTICS.largeEstimate).toBeGreaterThan(HEURISTICS.microEstimate)
    expect(HEURISTICS.broadTouchCount).toBeGreaterThan(HEURISTICS.microTouchCount)
  })
})

describe('DA2004 — fragmentacao excessiva', () => {
  it('aponta a cadeia linear de microtasks sem gate', () => {
    const result = compile({
      mission: {
        defaultsGate: null,
        tasks: [
          { id: 'T01', gate: null, estimate: 1 },
          { id: 'T02', dependencies: ['T01'], gate: null, estimate: 1 },
          { id: 'T03', dependencies: ['T02'], gate: null, estimate: 1 },
          { id: 'T04', dependencies: ['T03'], gate: 'mission' },
        ],
      },
    })
    const item = single(result.diagnostics, 'DA2004')
    expect(item.severity).toBe('WARNING')
    expect(item.targets).toEqual(['T01', 'T02', 'T03'])
    expect(item.message).toContain('T01 → T02 → T03')
  })

  it('nao aponta cadeia curta demais', () => {
    const result = compile({
      mission: {
        defaultsGate: null,
        tasks: [
          { id: 'T01', gate: null, estimate: 1 },
          { id: 'T02', dependencies: ['T01'], gate: null, estimate: 1 },
          { id: 'T04', dependencies: ['T02'], gate: 'mission' },
        ],
      },
    })
    expect(codesOf(result.diagnostics)).not.toContain('DA2004')
  })
})

describe('DA2005 — touches amplo demais', () => {
  it('aponta diretorio de topo inteiro', () => {
    const result = compile({
      mission: {
        tasks: [
          { id: 'T01' },
          { id: 'T02', dependencies: ['T01'], touches: ['scripts/'] },
          { id: 'T03', dependencies: ['T01'] },
          { id: 'T04', dependencies: ['T02', 'T03'], gate: 'mission' },
        ],
      },
    })
    const item = single(result.diagnostics, 'DA2005')
    expect(item.severity).toBe('WARNING')
    expect(item.targets).toEqual(['T02', 'scripts/'])
  })

  it('nao aponta arquivo isolado na raiz nem subdiretorio', () => {
    const result = compile({
      mission: {
        tasks: [
          { id: 'T01', touches: ['package.json'] },
          { id: 'T02', dependencies: ['T01'], touches: ['packages/a/b/'] },
          { id: 'T03', dependencies: ['T01'] },
          { id: 'T04', dependencies: ['T02', 'T03'], gate: 'mission' },
        ],
      },
    })
    expect(codesOf(result.diagnostics)).not.toContain('DA2005')
  })
})

describe('DA2006 — trabalho orfao', () => {
  it('aponta task terminal fora do mission gate', () => {
    const result = compile({
      mission: { tasks: [...BASE_TASKS, { id: 'T05', dependencies: ['T01'] }] },
    })
    const item = single(result.diagnostics, 'DA2006')
    expect(item.severity).toBe('WARNING')
    expect(item.targets).toEqual(['T05'])
  })
})

describe('DA2007 — risco alto sem revisao', () => {
  it('aponta requireReview false com risk high', () => {
    const result = compile({
      mission: {
        tasks: [
          { id: 'T01' },
          { id: 'T02', dependencies: ['T01'], risk: 'high', requireReview: false },
          { id: 'T03', dependencies: ['T01'] },
          { id: 'T04', dependencies: ['T02', 'T03'], gate: 'mission' },
        ],
      },
    })
    const item = single(result.diagnostics, 'DA2007')
    expect(item.severity).toBe('WARNING')
    expect(item.targets).toEqual(['T02'])
  })

  it('nao aponta risco alto com revisao exigida', () => {
    const result = compile({
      mission: {
        tasks: [
          { id: 'T01' },
          { id: 'T02', dependencies: ['T01'], risk: 'high' },
          { id: 'T03', dependencies: ['T01'] },
          { id: 'T04', dependencies: ['T02', 'T03'], gate: 'mission' },
        ],
      },
    })
    expect(codesOf(result.diagnostics)).not.toContain('DA2007')
  })
})

describe('DA2008 — revisao cruzada sem segundo fornecedor', () => {
  const mission = {
    tasks: [
      { id: 'T01' },
      { id: 'T02', dependencies: ['T01'], risk: 'high' as const },
      { id: 'T03', dependencies: ['T01'] },
      { id: 'T04', dependencies: ['T02', 'T03'], gate: 'mission' },
    ],
  }

  it('aponta as tasks que exigem revisao cruzada com um so fornecedor apto', () => {
    const result = compile({ mission, project: { providers: SINGLE_PROVIDER } })
    const item = single(result.diagnostics, 'DA2008')
    expect(item.severity).toBe('WARNING')
    expect(item.targets).toEqual(['T02'])
  })

  it('nao aponta quando o registry tem dois fornecedores aptos a revisar', () => {
    const result = compile({ mission })
    expect(codesOf(result.diagnostics)).not.toContain('DA2008')
  })
})

describe('DA3001 — fase posterior sem dependencia anterior', () => {
  it('informa a task que nao se liga a fase anterior', () => {
    const result = compile({
      mission: {
        phases: [{ id: 'alpha' }, { id: 'beta' }],
        tasks: [
          { id: 'T01' },
          { id: 'T02', phase: 'beta', dependencies: ['T01'] },
          { id: 'T03', phase: 'beta', dependencies: ['T02'], gate: 'mission' },
          { id: 'T04', dependencies: ['T01'], gate: 'mission' },
        ],
      },
    })
    const item = single(result.diagnostics, 'DA3001')
    expect(item.severity).toBe('INFO')
    expect(item.targets).toEqual(['T03', 'beta'])
  })
})

describe('DA3002 — sem paralelismo real', () => {
  it('informa que o plano e uma cadeia linear', () => {
    const result = compile({
      mission: {
        tasks: [
          { id: 'T01' },
          { id: 'T02', dependencies: ['T01'] },
          { id: 'T03', dependencies: ['T02'], gate: 'mission' },
        ],
      },
    })
    const item = single(result.diagnostics, 'DA3002')
    expect(item.severity).toBe('INFO')
    expect(item.targets).toEqual(['DA-TEST-001'])
    expect(result.graph?.waves).toHaveLength(3)
  })

  it('nao informa nada quando ha wave com mais de uma task', () => {
    expect(codesOf(compile().diagnostics)).not.toContain('DA3002')
  })
})

describe('postura diante de WARNING', () => {
  it('produz grafo e registra o aviso — o atrito e do start, nao da compilacao', () => {
    const result = compile({
      mission: { tasks: [...BASE_TASKS, { id: 'T05', dependencies: ['T01'] }] },
    })
    expect(result.graph).toBeDefined()
    expect(result.graph?.nodes).toHaveLength(5)
    expect(codesOf(result.diagnostics)).toEqual(['DA2006'])
  })
})
