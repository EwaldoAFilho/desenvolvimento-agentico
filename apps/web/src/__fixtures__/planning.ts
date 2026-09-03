import type {
  CreateDraftResultDto,
  PlanMissionResultDto,
  PlannerDto,
  PlanningFailureDto,
  RunHeaderDto,
  RunSnapshot,
  TaskDetail,
} from '@agentic/schemas'
import { makeCompileReport, makeSnapshot, MISSION_ID } from './snapshot.js'

/**
 * Fixture do contrato de planejamento (U01/U06). O que ela exercita de proposito: um
 * planejador REAL, um SIMULADO e um com o executavel ausente — sao esses tres que decidem se
 * a tela avisa consumo de assinatura, se ela se apresenta como capaz de planejar de verdade e
 * se ela oferece uma acao que o control plane recusaria.
 *
 * Nenhum planejador aqui aciona nada: a suite jamais consome assinatura (P17).
 */

export const REAL_PLANNER: PlannerDto = {
  providerId: 'agente-a',
  simulated: false,
  acceptsRevision: true,
  reportsUsage: false,
  state: 'INSTALLED',
}

export const SECOND_PLANNER: PlannerDto = {
  providerId: 'agente-b',
  simulated: false,
  acceptsRevision: true,
  reportsUsage: true,
  state: 'READY',
}

export const SIMULATED_PLANNER: PlannerDto = {
  providerId: 'mock',
  simulated: true,
  acceptsRevision: true,
  reportsUsage: false,
  state: 'READY',
}

export const BROKEN_PLANNER: PlannerDto = {
  providerId: 'agente-c',
  simulated: false,
  acceptsRevision: false,
  reportsUsage: false,
  state: 'NOT_INSTALLED',
}

export const DRAFT_RUN_ID = '01J8ZC0X0000000000000000AA'

/** O rascunho nasce `DRAFT`: nada foi aprovado nem executado (P15). */
export function makeDraftRun(missionId = MISSION_ID): RunHeaderDto {
  const snapshot = makeSnapshot()
  return {
    id: DRAFT_RUN_ID,
    missionId,
    status: 'DRAFT',
    timestamps: { createdAt: '2026-01-08T12:05:00.000Z' },
    policies: snapshot.run.policies,
  }
}

export function makePlanResult(overrides: Partial<PlanMissionResultDto> = {}): PlanMissionResultDto {
  return {
    missionId: MISSION_ID,
    file: `.agentic/missions/${MISSION_ID}.mission.yaml`,
    plannerId: REAL_PLANNER.providerId,
    revisions: 1,
    run: makeDraftRun(),
    report: makeCompileReport('warning'),
    rationale: 'quebrei o pedido em fases porque contratos e backend nao podem andar juntos.',
    ...overrides,
  }
}

/**
 * O grafo CONGELADO de um rascunho: mesma geometria do snapshot vivo, mas nada aconteceu
 * ainda. Toda task `PENDING`, nenhuma tentativa, nenhum tempo de parede — e assim que a
 * revisao do plano ve o mundo antes da aprovacao.
 */
export function makeDraftSnapshot(): RunSnapshot {
  const base = makeSnapshot()
  return {
    ...base,
    run: {
      ...base.run,
      id: DRAFT_RUN_ID,
      status: 'DRAFT',
      timestamps: { createdAt: '2026-01-08T12:05:00.000Z' },
    },
    tasks: base.tasks.map((task) => ({
      id: task.id,
      status: 'PENDING' as const,
      attemptCount: 0,
      unblockedBy: [...task.unblockedBy],
    })),
    counters: { ...base.counters, PENDING: 17, READY: 0, RUNNING: 0, DONE: 0, RETRY: 0, BLOCKED: 0 },
    metrics: {
      wallTimeMs: 0,
      attempts: 0,
      retries: 0,
      reviewFailures: 0,
      parallelismRatio: 0,
    },
  }
}

export function makeDraftResult(alreadyExisted = false): CreateDraftResultDto {
  return { run: makeDraftRun(), report: makeCompileReport('warning'), alreadyExisted }
}

/**
 * O detalhe de uma task como o control plane o devolve ANTES de qualquer tentativa: objetivo,
 * escopo, contrato de validacao e gate ja existem (vem da missao compilada); execucao,
 * isolamento e revisao ainda nao — a politica APLICADA so nasce com a tentativa (I10).
 */
export function makePlanTaskDetail(): TaskDetail {
  return {
    id: 'T09',
    title: 'Painel de propriedades',
    description: 'Reescreve o painel lateral com o novo contrato de propriedades.',
    objective: 'Painel de propriedades usando os contratos de leitura de T03.',
    phase: 'frontend',
    status: 'PENDING',
    graph: {
      dependencies: [{ id: 'T05', status: 'PENDING' }],
      dependents: ['T11'],
      onCriticalPath: true,
    },
    scope: {
      touches: ['ui/propriedades/'],
      reads: ['packages/contratos/leitura/'],
      outOfScopePaths: [],
    },
    execution: {},
    review: { findings: [] },
    isolation: {},
    quality: {
      validation: ['o painel recusa gravação sem permissão', 'npm test -w ui'],
      gate: 'frontend',
      commandResults: [],
    },
    facts: { filesChanged: [], diffStat: { files: 0, added: 0, removed: 0 }, evidence: [] },
    attempts: [],
    events: [],
  }
}

export function makePlanFailure(
  overrides: Partial<PlanningFailureDto> = {},
): PlanningFailureDto {
  return {
    code: 'CONTRACT_REJECTED',
    message: 'o plano proposto nao respeita o formato de missao',
    problems: [
      { path: 'tasks[3].objective', message: 'nao pode ser vazio' },
      { path: '', message: 'o plano nao declara nenhuma fase' },
    ],
    revisions: 2,
    plannerId: REAL_PLANNER.providerId,
    ...overrides,
  }
}
