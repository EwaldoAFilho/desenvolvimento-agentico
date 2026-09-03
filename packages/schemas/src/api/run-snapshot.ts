import { RUN_STATUSES, TASK_STATUSES, type TaskStatus, WORKSPACE_KINDS } from '@agentic/domain'
import { z } from 'zod'
import {
  GateIdSchema,
  MissionIdSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema,
  PathScopeSchema,
  PhaseIdSchema,
  PositiveIntSchema,
  ReviewPolicySchema,
  RiskSchema,
  TaskIdSchema,
} from '../common.js'
import { BlockageDtoSchema, IsoDateTimeSchema } from './common.js'
import { ProviderHealthDtoSchema } from './provider-health.js'

export const RunStatusSchema = z.enum(RUN_STATUSES)
export const TaskStatusSchema = z.enum(TASK_STATUSES)

export const RunTimestampsSchema = z
  .object({
    createdAt: IsoDateTimeSchema,
    approvedAt: IsoDateTimeSchema.optional(),
    startedAt: IsoDateTimeSchema.optional(),
    finishedAt: IsoDateTimeSchema.optional(),
  })
  .strict()

export const RunPoliciesDtoSchema = z
  .object({
    maxParallelTasks: PositiveIntSchema,
    maxExecutors: PositiveIntSchema,
    maxReviewers: NonNegativeIntSchema,
    defaultMaxAttempts: PositiveIntSchema,
    attemptTimeoutMs: PositiveIntSchema,
    retryBackoffMs: NonNegativeIntSchema,
    workspaceMode: z.enum(WORKSPACE_KINDS),
    enforceTouches: z.boolean(),
    denyPaths: z.array(z.string()),
  })
  .strict()

export type RunPoliciesDto = z.infer<typeof RunPoliciesDtoSchema>

export const RunHeaderSchema = z
  .object({
    id: NonEmptyStringSchema,
    missionId: MissionIdSchema,
    status: RunStatusSchema,
    timestamps: RunTimestampsSchema,
    policies: RunPoliciesDtoSchema,
    missionGate: GateIdSchema.optional(),
    integrationBranch: z.string().optional(),
    /**
     * Versao do plano que este run congelou. Sem ela, a tela so consegue perguntar "existe
     * run aprovado desta missao?" — e um run APPROVED antigo faz um YAML NOVO parecer
     * aprovado, liberando execucao de um plano que ninguem inspecionou.
     */
    specHash: z.string().optional(),
  })
  .strict()

export type RunHeaderDto = z.infer<typeof RunHeaderSchema>

/**
 * Geometria do DAG. Vem da missao compilada e e congelada no inicio do run: no nao dança a
 * cada evento — so cor, icone e rotulo mudam (DASHBOARD 6).
 */
export const GraphNodeDtoSchema = z
  .object({
    id: TaskIdSchema,
    title: NonEmptyStringSchema,
    phase: PhaseIdSchema,
    dependencies: z.array(TaskIdSchema),
    touches: z.array(PathScopeSchema),
    risk: RiskSchema,
    estimate: z.number().positive(),
    /**
     * Exigencia de revisao DECLARADA pela task. Sem estes dois, a tela so conseguia mostrar
     * o teto global de revisores do run, e tasks com exigencias diferentes ficavam
     * indistinguiveis na inspecao do plano — justamente onde o humano decide se aprova.
     */
    requireReview: z.boolean().optional(),
    reviewPolicy: ReviewPolicySchema.optional(),
  })
  .strict()

export type GraphNodeDto = z.infer<typeof GraphNodeDtoSchema>

export const GraphEdgeDtoSchema = z.object({ from: TaskIdSchema, to: TaskIdSchema }).strict()

export type GraphEdgeDto = z.infer<typeof GraphEdgeDtoSchema>

export const RunGraphDtoSchema = z
  .object({
    nodes: z.array(GraphNodeDtoSchema),
    edges: z.array(GraphEdgeDtoSchema),
    waves: z.array(z.array(TaskIdSchema)),
    criticalPath: z.array(TaskIdSchema),
    slack: z.record(TaskIdSchema, z.number()),
  })
  .strict()

export type RunGraphDto = z.infer<typeof RunGraphDtoSchema>

export const TaskSnapshotDtoSchema = z
  .object({
    id: TaskIdSchema,
    status: TaskStatusSchema,
    attemptCount: NonNegativeIntSchema,
    currentAttempt: z.string().optional(),
    unblockedBy: z.array(TaskIdSchema),
    blockage: BlockageDtoSchema.optional(),
    readyAt: IsoDateTimeSchema.optional(),
    startedAt: IsoDateTimeSchema.optional(),
    finishedAt: IsoDateTimeSchema.optional(),
    durationMs: NonNegativeIntSchema.optional(),
  })
  .strict()

export type TaskSnapshotDto = z.infer<typeof TaskSnapshotDtoSchema>

const counterShape = Object.fromEntries(
  TASK_STATUSES.map((status) => [status, NonNegativeIntSchema.default(0)]),
) as Record<TaskStatus, z.ZodDefault<typeof NonNegativeIntSchema>>

/** Um contador por estado, sempre presente: cabecalho do dashboard nao tem buraco. */
export const TaskCountersSchema = z.object(counterShape).strict()

export type TaskCountersDto = z.infer<typeof TaskCountersSchema>

export const RunMetricsDtoSchema = z
  .object({
    wallTimeMs: NonNegativeIntSchema,
    attempts: NonNegativeIntSchema,
    retries: NonNegativeIntSchema,
    reviewFailures: NonNegativeIntSchema,
    parallelismRatio: z.number().min(0),
  })
  .strict()

export type RunMetricsDto = z.infer<typeof RunMetricsDtoSchema>

export const RunSnapshotSchema = z
  .object({
    run: RunHeaderSchema,
    graph: RunGraphDtoSchema,
    tasks: z.array(TaskSnapshotDtoSchema),
    counters: TaskCountersSchema,
    providers: z.array(ProviderHealthDtoSchema),
    metrics: RunMetricsDtoSchema,
  })
  .strict()

export type RunSnapshot = z.infer<typeof RunSnapshotSchema>
