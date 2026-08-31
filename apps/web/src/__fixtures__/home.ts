import type {
  MissionSummaryDto,
  ProjectDto,
  ProjectHomeDto,
  ProviderHealthDto,
  RunSummaryDto,
} from '@agentic/schemas'
import { PROVIDERS_WITH_ENVIRONMENT } from './snapshot.js'

/**
 * Fixture do contrato do Project Home (U04). O que ela exercita de proposito: uma missao de
 * cada estado que a Home precisa saber pintar — inclusive a que NAO compila e a que nao
 * declara id, porque sao justamente as que nao podem ganhar botao.
 */

const COUNTERS = {
  PENDING: 3,
  READY: 1,
  RUNNING: 2,
  VERIFYING: 0,
  REVIEW: 0,
  INTEGRATING: 0,
  DONE: 6,
  FAILED: 0,
  RETRY: 0,
  BLOCKED: 0,
  SKIPPED: 0,
  CANCELLED: 0,
}

export const RUNNING_RUN: RunSummaryDto = {
  id: '01J8ZC0X0000000000000RUN01',
  missionId: 'DA-BPM-021',
  status: 'RUNNING',
  createdAt: '2026-01-08T12:05:00.000Z',
  startedAt: '2026-01-08T12:10:00.000Z',
  counters: COUNTERS,
}

export const COMPLETED_RUN: RunSummaryDto = {
  id: '01J8ZC0X0000000000000RUN02',
  missionId: 'DA-DOC-004',
  status: 'COMPLETED',
  createdAt: '2026-01-07T09:00:00.000Z',
  startedAt: '2026-01-07T09:02:00.000Z',
  finishedAt: '2026-01-07T09:41:00.000Z',
  counters: { ...COUNTERS, PENDING: 0, READY: 0, RUNNING: 0, DONE: 12 },
}

export const DRAFT_RUN: RunSummaryDto = {
  id: '01J8ZC0X0000000000000RUN03',
  missionId: 'DA-API-002',
  status: 'DRAFT',
  createdAt: '2026-01-08T11:00:00.000Z',
}

export const MISSIONS: MissionSummaryDto[] = [
  {
    id: 'DA-BPM-021',
    file: '.agentic/missions/DA-BPM-021.mission.yaml',
    title: 'Refinar painel de propriedades BPM',
    state: 'RUNNING',
    tasks: 12,
    phases: 4,
    errors: 0,
    warnings: 2,
    lastRun: RUNNING_RUN,
  },
  {
    id: 'DA-API-002',
    file: '.agentic/missions/DA-API-002.mission.yaml',
    title: 'Endpoint de consulta paginada',
    state: 'DRAFT',
    tasks: 6,
    phases: 2,
    errors: 0,
    warnings: 0,
    lastRun: DRAFT_RUN,
  },
  {
    id: 'DA-UI-003',
    file: '.agentic/missions/DA-UI-003.mission.yaml',
    title: 'Tela de listagem',
    state: 'PLANNED',
    tasks: 4,
    phases: 2,
    errors: 0,
    warnings: 1,
  },
  {
    id: 'DA-DOC-004',
    file: '.agentic/missions/DA-DOC-004.mission.yaml',
    title: 'Manual de operação',
    state: 'COMPLETED',
    tasks: 12,
    phases: 3,
    errors: 0,
    warnings: 0,
    lastRun: COMPLETED_RUN,
  },
  {
    // Nao compila: fica na lista (some-la esconderia o que precisa de conserto) e sem titulo.
    file: '.agentic/missions/quebrada.mission.yaml',
    title: '',
    state: 'INVALID',
    tasks: 0,
    phases: 0,
    errors: 2,
    warnings: 0,
  },
]

export const PROJECT: ProjectDto = {
  name: 'projeto-exemplo',
  configured: true,
  missionsDir: '.agentic/missions',
  defaultProvider: 'agente-a',
  gates: ['unit', 'web', 'mission'],
  providers: PROVIDERS_WITH_ENVIRONMENT.map((provider) => ({ ...provider })),
  planners: [],
}

export function makeProjectHome(): ProjectHomeDto {
  return {
    project: { ...PROJECT, providers: PROJECT.providers.map((provider) => ({ ...provider })) },
    missions: MISSIONS.map((mission) => ({ ...mission })),
    runs: [RUNNING_RUN, DRAFT_RUN, COMPLETED_RUN],
  }
}

/** Projeto recem-criado: control plane no ar, nenhuma missao, nenhuma execucao. */
export function makeEmptyProjectHome(): ProjectHomeDto {
  return {
    project: {
      name: 'projeto-novo',
      configured: true,
      missionsDir: '.agentic/missions',
      gates: [],
      providers: [],
      planners: [],
    },
    missions: [],
    runs: [],
  }
}

/** Home sem nenhuma execucao ativa: a Home aparece, o dashboard de execucao nao sequestra. */
export function makeIdleProjectHome(): ProjectHomeDto {
  const home = makeProjectHome()
  return {
    ...home,
    missions: home.missions.filter((mission) => mission.state !== 'RUNNING'),
    runs: [DRAFT_RUN, COMPLETED_RUN],
  }
}

export const READY_PROVIDER: ProviderHealthDto = {
  providerId: 'mock',
  installed: true,
  ready: true,
  version: '0.0.0',
  detail: 'provider de teste',
  running: 0,
  capacity: 8,
  probedAt: '2026-01-08T12:40:00.000Z',
}

export const UNKNOWN_PROVIDER: ProviderHealthDto = {
  providerId: 'agente-a',
  installed: true,
  ready: 'unknown',
  version: '2.1.4',
  detail: 'CLI nao expoe estado de autenticacao',
  running: 0,
  capacity: 3,
  probedAt: '2026-01-08T12:40:00.000Z',
}

export const MISSING_PROVIDER: ProviderHealthDto = {
  providerId: 'agente-b',
  installed: false,
  ready: false,
  version: 'unknown',
  detail: 'executavel ausente',
  running: 0,
  capacity: 2,
  probedAt: '2026-01-08T12:40:00.000Z',
}
