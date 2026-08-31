import { describe, expect, it } from 'vitest'
import { gateId, missionId, phaseId, providerId, taskId } from '../ids.js'
import type { MissionSpec } from '../mission.js'
import { pathScope } from '../path-scope.js'
import type {
  MissionPlanner,
  PlanningCapabilities,
  PlanningContext,
  PlanningRequest,
  PlanningResult,
} from './planning.js'
import { MAX_PLAN_REVISIONS, PLANNING_FAILURE_CODES } from './planning.js'

const context: PlanningContext = {
  readRoot: '/tmp/projeto',
  takenMissionIds: [missionId('DA-EXEMPLO-001')],
  availableGates: [gateId('unit')],
  constraints: ['nenhuma credencial e lida, guardada ou injetada'],
  denyPaths: ['.agentic/', '*.pem'],
}

const request: PlanningRequest = {
  prompt: 'quero um relatorio de estoque por deposito',
  context,
  timeoutMs: 300_000,
}

const spec: MissionSpec = {
  id: missionId('DA-EXEMPLO-002'),
  title: 'Relatorio de estoque',
  objective: 'somar saldo por deposito',
  scope: [],
  outOfScope: [],
  constraints: [],
  acceptanceCriteria: ['o relatorio soma por deposito'],
  defaults: {},
  phases: [{ id: phaseId('core'), title: 'Nucleo' }],
  tasks: [
    {
      id: taskId('T01'),
      phase: phaseId('core'),
      title: 'Somar saldo',
      objective: 'agregar por deposito',
      dependencies: [],
      touches: [pathScope('src/estoque.js')],
      validation: ['soma confere com o extrato'],
      risk: 'low',
    },
  ],
}

describe('PlanningRequest — planejar acontece antes de existir tentativa', () => {
  it('a requisicao completa nao tem taskId, attemptId nem workspacePath', () => {
    const campos = new Set([...Object.keys(request), ...Object.keys(request.context)])

    expect(campos.has('taskId')).toBe(false)
    expect(campos.has('attemptId')).toBe(false)
    expect(campos.has('workspacePath')).toBe(false)
    expect(campos.has('runId')).toBe(false)
  })

  it('a raiz de leitura nao e um workspace: sem lease, sem branch, sem commit base', () => {
    const workspaceish = ['branch', 'baseCommit', 'leasedBy', 'kind']
    for (const campo of workspaceish) expect(campo in context).toBe(false)
    expect(context.readRoot).toBe('/tmp/projeto')
  })

  it('o ciclo de reparo devolve ao planejador o que ele produziu e o motivo da recusa', () => {
    const comReparo: PlanningRequest = {
      ...request,
      revision: {
        attempt: 1,
        previous: '{"id":"DA-EXEMPLO-002"}',
        problems: [{ path: 'tasks', message: 'declare ao menos uma task' }],
      },
    }

    expect(comReparo.revision?.attempt).toBeLessThanOrEqual(MAX_PLAN_REVISIONS)
    expect(comReparo.revision?.problems[0]?.path).toBe('tasks')
  })

  it('duas correcoes e a decisao volta ao humano', () => {
    expect(MAX_PLAN_REVISIONS).toBe(2)
  })
})

describe('PlanningResult — plano validado ou falha explicada, nunca plano parcial', () => {
  it('a proposta carrega o plano como dado, sem documento nem caminho de arquivo', () => {
    const result: PlanningResult = {
      outcome: 'proposed',
      proposal: { mission: spec, rationale: 'uma fase basta para o escopo pedido' },
      logsRef: 'artifacts/planning/1.log',
    }

    expect(result.outcome).toBe('proposed')
    if (result.outcome !== 'proposed') return
    expect(result.proposal.mission.tasks).toHaveLength(1)
    expect('document' in result.proposal).toBe(false)
    expect('file' in result.proposal).toBe(false)
    expect('path' in result.proposal).toBe(false)
  })

  it('a recusa diz o codigo, a frase e onde o plano feriu o contrato', () => {
    const result: PlanningResult = {
      outcome: 'refused',
      failure: {
        code: 'CONTRACT_REJECTED',
        message: 'a proposta nao respeita o contrato de missao',
        problems: [{ path: 'tasks[0].objective', message: 'nao pode ser vazio' }],
        raw: '{"tasks":[{"objective":""}]}',
      },
      logsRef: 'artifacts/planning/2.log',
    }

    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') return
    expect(result.failure.problems[0]?.path).toBe('tasks[0].objective')
  })

  it('o catalogo de falhas separa problema de processo de problema de plano', () => {
    expect([...PLANNING_FAILURE_CODES]).toEqual([
      'PLANNER_UNAVAILABLE',
      'PLANNER_FAILED',
      'PLANNER_TIMEOUT',
      'PLANNER_CANCELLED',
      'NO_PROPOSAL',
      'CONTRACT_REJECTED',
      'PLAN_UNCHANGED',
      'REVISIONS_EXHAUSTED',
    ])
    expect(new Set(PLANNING_FAILURE_CODES).size).toBe(PLANNING_FAILURE_CODES.length)
  })
})

describe('MissionPlanner — le, propoe e termina', () => {
  const capabilities: PlanningCapabilities = {
    simulated: true,
    acceptsRevision: true,
    reportsUsage: false,
  }

  const planner: MissionPlanner = {
    id: providerId('planejador-de-teste'),
    capabilities: () => capabilities,
    plan: async () => ({
      outcome: 'proposed',
      proposal: { mission: spec },
      logsRef: 'artifacts/planning/3.log',
    }),
  }

  it('a porta nao oferece aprovar, executar nem escrever', () => {
    const superficie = Object.keys(planner)
    expect(superficie.sort()).toEqual(['capabilities', 'id', 'plan'])
  })

  it('planejador simulado se declara simulado — nao se apresenta como real', () => {
    expect(planner.capabilities().simulated).toBe(true)
  })

  it('planejar so exige o pedido, o contexto de leitura e o limite de tempo', async () => {
    const result = await planner.plan(request)
    expect(result.outcome).toBe('proposed')
  })
})
