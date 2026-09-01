import type {
  PlanMissionResultDto,
  PlannerDto,
  PlanningFailureDto,
  RunHeaderDto,
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
