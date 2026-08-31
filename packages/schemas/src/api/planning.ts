import { PLANNING_FAILURE_CODES } from '@agentic/domain'
import { z } from 'zod'
import {
  MissionIdSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema,
  ProviderIdSchema,
  RepoRelativePathSchema,
} from '../common.js'
import { CompileReportDtoSchema } from './compile-report.js'
import { ProviderStateSchema } from './provider-health.js'
import { RunHeaderSchema } from './run-snapshot.js'

/**
 * Quem pode planejar, e com que honestidade se apresenta. `simulated` nao e detalhe de
 * teste: e o que impede um planejador de fixture de ser oferecido como planejamento de
 * verdade, e o que diz a interface se a acao vai consumir a assinatura do usuario (P17).
 */
export const PlannerDtoSchema = z
  .object({
    providerId: ProviderIdSchema,
    simulated: z.boolean(),
    acceptsRevision: z.boolean(),
    reportsUsage: z.boolean(),
    /** Ambiente do fornecedor, com a mesma derivacao do painel: `unknown` continua `unknown`. */
    state: ProviderStateSchema,
  })
  .strict()

export type PlannerDto = z.infer<typeof PlannerDtoSchema>

/**
 * Pedir um plano. `acceptsSubscriptionUse` e obrigatorio e explicito, como `acceptWarnings`
 * na partida: acionar fornecedor real gasta a assinatura do usuario, e isso se avisa antes,
 * nunca depois (P17, DASHBOARD 2.1).
 */
export const PlanMissionCommandSchema = z
  .object({
    prompt: NonEmptyStringSchema,
    /** Ausente = o padrao do projeto. Com um so planejador, escolher e desnecessario. */
    plannerId: ProviderIdSchema.optional(),
    acceptsSubscriptionUse: z.boolean(),
    actor: NonEmptyStringSchema,
  })
  .strict()

export type PlanMissionCommand = z.infer<typeof PlanMissionCommandSchema>

export const PlanProblemDtoSchema = z
  .object({
    /** `tasks[3].objective`. Vazio quando o problema e do plano inteiro. */
    path: z.string(),
    message: NonEmptyStringSchema,
  })
  .strict()

export type PlanProblemDto = z.infer<typeof PlanProblemDtoSchema>

/** Catalogo unico: o enum vem do dominio, nao de uma copia que envelhece sozinha. */
export const PlanningFailureCodeSchema = z.enum(PLANNING_FAILURE_CODES)

/**
 * Falha de planejamento e diagnostico, nao plano vazio. A tela precisa poder dizer o que
 * aconteceu e quantas correcoes foram gastas antes de devolver a decisao ao humano.
 */
export const PlanningFailureDtoSchema = z
  .object({
    code: PlanningFailureCodeSchema,
    message: NonEmptyStringSchema,
    problems: z.array(PlanProblemDtoSchema),
    revisions: NonNegativeIntSchema,
    plannerId: ProviderIdSchema,
  })
  .strict()

export type PlanningFailureDto = z.infer<typeof PlanningFailureDtoSchema>

/**
 * Resultado de um planejamento bem-sucedido. O run nasce `DRAFT`: aprovar continua sendo
 * ato humano registrado, e nao existe caminho que pule essa etapa (P15).
 */
export const PlanMissionResultDtoSchema = z
  .object({
    missionId: MissionIdSchema,
    /** Artefato gravado pelo control plane, relativo a raiz do projeto. */
    file: RepoRelativePathSchema,
    plannerId: ProviderIdSchema,
    /** Quantas correcoes foram necessarias. `0` = acertou de primeira. */
    revisions: NonNegativeIntSchema,
    run: RunHeaderSchema,
    report: CompileReportDtoSchema,
    /** Relato do planejador sobre as proprias escolhas. Nao decide nada (P05). */
    rationale: z.string().optional(),
  })
  .strict()

export type PlanMissionResultDto = z.infer<typeof PlanMissionResultDtoSchema>

/**
 * Rascunho criado a partir de missao que ja existe no repositorio — sem planejador e sem
 * aprovacao. `alreadyExisted` sustenta a idempotencia: a mesma versao do plano devolve o
 * mesmo run, entao clicar duas vezes nao cria dois.
 */
export const CreateDraftResultDtoSchema = z
  .object({
    run: RunHeaderSchema,
    report: CompileReportDtoSchema,
    alreadyExisted: z.boolean(),
  })
  .strict()

export type CreateDraftResultDto = z.infer<typeof CreateDraftResultDtoSchema>
