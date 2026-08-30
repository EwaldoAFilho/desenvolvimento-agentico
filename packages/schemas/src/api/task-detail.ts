import { ATTEMPT_RESULTS, FAILURE_CODES, GATE_STATUSES, WORKSPACE_KINDS } from '@agentic/domain'
import { z } from 'zod'
import {
  GateIdSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema,
  PathScopeSchema,
  PhaseIdSchema,
  PositiveIntSchema,
  ProviderIdSchema,
  ReviewPolicySchema,
  TaskIdSchema,
} from '../common.js'
import {
  AgentIdentityDtoSchema,
  BlockageDtoSchema,
  CommandResultDtoSchema,
  DiffStatDtoSchema,
  EvidenceRefDtoSchema,
  FileChangeDtoSchema,
  IsoDateTimeSchema,
  ReviewFindingDtoSchema,
  ReviewPolicyOutcomeSchema,
  ReviewVerdictSchema,
} from './common.js'
import { EventDtoSchema } from './events.js'
import { TaskStatusSchema } from './run-snapshot.js'

export const FailureCodeSchema = z.enum(FAILURE_CODES)

export const TaskFailureDtoSchema = z
  .object({ failureCode: FailureCodeSchema, detail: z.string().optional() })
  .strict()

export type TaskFailureDto = z.infer<typeof TaskFailureDtoSchema>

/** Dependencia com o estado de cada uma: o painel diz "Depende T01 ✔ T02 ✔". */
export const DependencyStateDtoSchema = z
  .object({ id: TaskIdSchema, status: TaskStatusSchema })
  .strict()

export const TaskGraphDetailSchema = z
  .object({
    dependencies: z.array(DependencyStateDtoSchema),
    dependents: z.array(TaskIdSchema),
    onCriticalPath: z.boolean(),
  })
  .strict()

export const TaskScopeDetailSchema = z
  .object({
    touches: z.array(PathScopeSchema),
    reads: z.array(PathScopeSchema),
    outOfScopePaths: z.array(z.string()),
  })
  .strict()

export const AttemptCounterSchema = z
  .object({ number: PositiveIntSchema, max: PositiveIntSchema })
  .strict()

export const TaskExecutionDetailSchema = z
  .object({
    provider: ProviderIdSchema.optional(),
    executor: AgentIdentityDtoSchema.optional(),
    attempt: AttemptCounterSchema.optional(),
    startedAt: IsoDateTimeSchema.optional(),
    durationMs: NonNegativeIntSchema.optional(),
  })
  .strict()

/** Politica aplicada E se foi rebaixada: I10 exige que o rebaixamento seja visivel. */
export const TaskReviewDetailSchema = z
  .object({
    reviewer: AgentIdentityDtoSchema.optional(),
    reviewerProvider: ProviderIdSchema.optional(),
    policy: ReviewPolicySchema.optional(),
    policyOutcome: ReviewPolicyOutcomeSchema.optional(),
    verdict: ReviewVerdictSchema.optional(),
    findings: z.array(ReviewFindingDtoSchema).default([]),
  })
  .strict()

/** O caminho da worktree aparece com botao de copiar: `code <caminho>` resolve hoje. */
export const TaskIsolationDetailSchema = z
  .object({
    kind: z.enum(WORKSPACE_KINDS).optional(),
    worktreePath: z.string().optional(),
    branch: z.string().optional(),
    baseCommit: z.string().optional(),
    commit: z.string().optional(),
  })
  .strict()

export const TaskQualityDetailSchema = z
  .object({
    validation: z.array(z.string()),
    gate: GateIdSchema.optional(),
    gateStatus: z.enum(GATE_STATUSES).optional(),
    commandResults: z.array(CommandResultDtoSchema),
  })
  .strict()

export const TaskFactsDetailSchema = z
  .object({
    filesChanged: z.array(FileChangeDtoSchema),
    diffStat: DiffStatDtoSchema,
    evidence: z.array(EvidenceRefDtoSchema),
  })
  .strict()

export const AttemptSummaryDtoSchema = z
  .object({
    id: NonEmptyStringSchema,
    attemptNumber: PositiveIntSchema,
    executor: AgentIdentityDtoSchema.optional(),
    startedAt: IsoDateTimeSchema,
    finishedAt: IsoDateTimeSchema.optional(),
    durationMs: NonNegativeIntSchema.optional(),
    result: z.enum(ATTEMPT_RESULTS).optional(),
    failure: TaskFailureDtoSchema.optional(),
    gateStatus: z.enum(GATE_STATUSES).optional(),
    reviewVerdict: ReviewVerdictSchema.optional(),
    worktreePath: z.string().optional(),
    branch: z.string().optional(),
    commit: z.string().optional(),
  })
  .strict()

export type AttemptSummaryDto = z.infer<typeof AttemptSummaryDtoSchema>

/** Os grupos sao os da tabela de DASHBOARD 5: o card mostra pouco, o painel mostra tudo. */
export const TaskDetailSchema = z
  .object({
    id: TaskIdSchema,
    title: NonEmptyStringSchema,
    description: z.string().optional(),
    objective: NonEmptyStringSchema,
    phase: PhaseIdSchema,
    status: TaskStatusSchema,
    graph: TaskGraphDetailSchema,
    scope: TaskScopeDetailSchema,
    execution: TaskExecutionDetailSchema,
    review: TaskReviewDetailSchema,
    isolation: TaskIsolationDetailSchema,
    quality: TaskQualityDetailSchema,
    facts: TaskFactsDetailSchema,
    failure: TaskFailureDtoSchema.optional(),
    blockage: BlockageDtoSchema.optional(),
    attempts: z.array(AttemptSummaryDtoSchema),
    events: z.array(EventDtoSchema),
  })
  .strict()

export type TaskDetail = z.infer<typeof TaskDetailSchema>
