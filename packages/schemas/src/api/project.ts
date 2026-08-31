import type { RunStatus } from '@agentic/domain'
import { z } from 'zod'
import {
  GateIdSchema,
  MissionIdSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema,
  ProviderIdSchema,
  RepoRelativePathSchema,
} from '../common.js'
import { IsoDateTimeSchema } from './common.js'
import { PlannerDtoSchema } from './planning.js'
import { ProviderHealthDtoSchema } from './provider-health.js'
import { RunStatusSchema, TaskCountersSchema } from './run-snapshot.js'

/**
 * Execucao vista de fora: o que a Home precisa para listar sem abrir o snapshot inteiro.
 */
export const RunSummaryDtoSchema = z
  .object({
    id: NonEmptyStringSchema,
    missionId: MissionIdSchema,
    status: RunStatusSchema,
    createdAt: IsoDateTimeSchema,
    startedAt: IsoDateTimeSchema.optional(),
    finishedAt: IsoDateTimeSchema.optional(),
    /** Ausente quando os contadores nao foram apurados — nao vira uma linha de zeros. */
    counters: TaskCountersSchema.optional(),
  })
  .strict()

export type RunSummaryDto = z.infer<typeof RunSummaryDtoSchema>

/**
 * Estado da missao COMO A HOME MOSTRA. Nao e estado persistido de nada: e derivacao de dois
 * fatos que ja viajam no payload — a missao compila? qual o ultimo run? Sem ele cada tela
 * inventa a propria regra e oferece acao impossivel.
 */
export const MISSION_VIEW_STATES = [
  /** Nao compila: ha ERROR. Nao existe botao de partida, existe lista de erros. */
  'INVALID',
  /** Compila e nunca virou run. */
  'PLANNED',
  /** Ha rascunho aguardando ato humano de aprovacao. */
  'DRAFT',
  /** Aprovada, ainda nao iniciada. */
  'APPROVED',
  /** Ha execucao em andamento (inclui PAUSED, BLOCKED e VERIFYING). */
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const

export type MissionViewState = (typeof MISSION_VIEW_STATES)[number]

export const MissionViewStateSchema = z.enum(MISSION_VIEW_STATES)

/** Tabela explicita: nenhum estado de run cai num `default` silencioso. */
const STATE_BY_RUN_STATUS = {
  DRAFT: 'DRAFT',
  APPROVED: 'APPROVED',
  RUNNING: 'RUNNING',
  PAUSED: 'RUNNING',
  BLOCKED: 'RUNNING',
  VERIFYING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const satisfies Record<RunStatus, MissionViewState>

export interface MissionStateInput {
  /** `false` quando o compilador reportou qualquer ERROR. */
  readonly compiles: boolean
  /** Estado do run mais recente desta missao; ausente quando nunca houve run. */
  readonly lastRunStatus?: RunStatus
}

/**
 * Execucao viva ganha de tudo: o grafo foi congelado na partida, entao editar o YAML depois
 * nao invalida o que ja esta rodando (ADR-0005). Fora isso, um arquivo que nao compila e
 * `INVALID` — e ainda assim aparece na lista, porque some-lo esconderia justamente o que
 * precisa de conserto.
 */
export function missionStateOf(input: MissionStateInput): MissionViewState {
  const status = input.lastRunStatus
  const fromRun = status === undefined ? undefined : STATE_BY_RUN_STATUS[status]
  if (fromRun === 'RUNNING') return 'RUNNING'
  if (!input.compiles) return 'INVALID'
  return fromRun ?? 'PLANNED'
}

/**
 * Uma missao na listagem da Home. `file` e relativo: a listagem atual entrega o caminho
 * absoluto do host ao navegador, e isso para aqui (ARCHITECTURE 9).
 */
export const MissionSummaryDtoSchema = z
  .object({
    /** Ausente quando o arquivo nao chega a declarar um id valido — o item ainda e listado. */
    id: MissionIdSchema.optional(),
    file: RepoRelativePathSchema,
    /** Vazio quando o arquivo nao compila: preferimos vazio a um titulo inventado. */
    title: z.string(),
    state: MissionViewStateSchema,
    tasks: NonNegativeIntSchema,
    phases: NonNegativeIntSchema,
    errors: NonNegativeIntSchema,
    warnings: NonNegativeIntSchema,
    lastRun: RunSummaryDtoSchema.optional(),
  })
  .strict()

export type MissionSummaryDto = z.infer<typeof MissionSummaryDtoSchema>

/**
 * Identidade e ambiente do projeto. Responde sem nenhum run criado: e o que separa "projeto
 * novo" de "carregando para sempre".
 */
export const ProjectDtoSchema = z
  .object({
    name: NonEmptyStringSchema,
    /** `false` = sem `.agentic/project.yaml` legivel. A Home mostra onboarding, nao erro. */
    configured: z.boolean(),
    missionsDir: RepoRelativePathSchema,
    defaultProvider: ProviderIdSchema.optional(),
    gates: z.array(GateIdSchema),
    providers: z.array(ProviderHealthDtoSchema),
    /** Quem pode planejar. Vazio e resposta legitima: nao ha planejador configurado. */
    planners: z.array(PlannerDtoSchema),
  })
  .strict()

export type ProjectDto = z.infer<typeof ProjectDtoSchema>

/** Uma leitura previsivel: a Home nao encadeia tres chamadas para desenhar a primeira tela. */
export const ProjectHomeDtoSchema = z
  .object({
    project: ProjectDtoSchema,
    missions: z.array(MissionSummaryDtoSchema),
    runs: z.array(RunSummaryDtoSchema),
  })
  .strict()

export type ProjectHomeDto = z.infer<typeof ProjectHomeDtoSchema>
