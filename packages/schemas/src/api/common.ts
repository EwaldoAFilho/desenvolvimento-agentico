import {
  type ActorKind,
  BLOCKAGE_KINDS,
  EVIDENCE_KINDS,
  type FileChangeKind,
  type FindingSeverity,
  GATE_STATUSES,
  REVIEW_VERDICTS,
  type ReviewPolicyOutcome,
  type ScopeCheck,
} from '@agentic/domain'
import { z } from 'zod'
import {
  AgentProfileIdSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema,
  ProviderIdSchema,
} from '../common.js'

/** Na fronteira, tempo e string ISO-8601: `Date` nao sobrevive a um JSON. */
export const IsoDateTimeSchema = z.string().datetime({ offset: true })

export const ACTOR_KINDS = [
  'orchestrator',
  'human',
  'agent',
  'system',
] as const satisfies readonly ActorKind[]

export const REVIEW_POLICY_OUTCOMES = [
  'satisfied',
  'downgraded',
] as const satisfies readonly ReviewPolicyOutcome[]

export const FINDING_SEVERITIES = [
  'info',
  'warning',
  'error',
] as const satisfies readonly FindingSeverity[]

export const SCOPE_CHECKS = ['PASS', 'VIOLATION'] as const satisfies readonly ScopeCheck[]

export const FILE_CHANGE_KINDS = [
  'A',
  'M',
  'D',
  'R',
  'C',
  'T',
] as const satisfies readonly FileChangeKind[]

export const ActorDtoSchema = z
  .object({
    kind: z.enum(ACTOR_KINDS),
    id: z.string().optional(),
  })
  .strict()

export type ActorDto = z.infer<typeof ActorDtoSchema>

/** Sessao nova, identidade nova: `sessionRef` e a chave que sustenta I3. */
export const AgentIdentityDtoSchema = z
  .object({
    profileId: AgentProfileIdSchema,
    providerId: ProviderIdSchema,
    model: z.string().optional(),
    sessionRef: NonEmptyStringSchema,
    startedAt: IsoDateTimeSchema,
  })
  .strict()

export type AgentIdentityDto = z.infer<typeof AgentIdentityDtoSchema>

/** Fato reproduzivel: comando exato, cwd, exit code e ponteiro para a saida persistida. */
export const CommandResultDtoSchema = z
  .object({
    command: z.string(),
    cwd: z.string(),
    exitCode: z.number().int().nullable(),
    durationMs: NonNegativeIntSchema,
    stdoutRef: z.string().optional(),
    stderrRef: z.string().optional(),
    truncated: z.boolean(),
    timedOut: z.boolean().optional(),
  })
  .strict()

export type CommandResultDto = z.infer<typeof CommandResultDtoSchema>

export const GateExecutionDtoSchema = z
  .object({
    id: z.string(),
    gateId: z.string(),
    scope: z.enum(['task', 'mission']),
    status: z.enum(GATE_STATUSES),
    startedAt: IsoDateTimeSchema,
    finishedAt: IsoDateTimeSchema.optional(),
    results: z.array(CommandResultDtoSchema),
  })
  .strict()

export type GateExecutionDto = z.infer<typeof GateExecutionDtoSchema>

export const FileChangeDtoSchema = z
  .object({
    path: z.string(),
    change: z.enum(FILE_CHANGE_KINDS),
    added: NonNegativeIntSchema,
    removed: NonNegativeIntSchema,
    renamedFrom: z.string().optional(),
  })
  .strict()

export type FileChangeDto = z.infer<typeof FileChangeDtoSchema>

export const DiffStatDtoSchema = z
  .object({
    files: NonNegativeIntSchema,
    added: NonNegativeIntSchema,
    removed: NonNegativeIntSchema,
  })
  .strict()

export type DiffStatDto = z.infer<typeof DiffStatDtoSchema>

export const EvidenceRefDtoSchema = z
  .object({
    kind: z.enum(EVIDENCE_KINDS),
    sourceId: z.string(),
    artifactPath: z.string().optional(),
    digest: z.string(),
  })
  .strict()

export type EvidenceRefDto = z.infer<typeof EvidenceRefDtoSchema>

export const ReviewFindingDtoSchema = z
  .object({
    severity: z.enum(FINDING_SEVERITIES),
    path: z.string().optional(),
    line: z.number().int().optional(),
    message: z.string(),
    evidenceRef: EvidenceRefDtoSchema.optional(),
  })
  .strict()

export type ReviewFindingDto = z.infer<typeof ReviewFindingDtoSchema>

export const ReviewVerdictSchema = z.enum(REVIEW_VERDICTS)

export const ReviewPolicyOutcomeSchema = z.enum(REVIEW_POLICY_OUTCOMES)

/** BLOCKED e estado de primeira classe: o painel precisa dizer o que falta e para quem. */
export const BlockageDtoSchema = z
  .object({
    kind: z.enum(BLOCKAGE_KINDS),
    reason: z.string(),
    raisedBy: z.string(),
    raisedAt: IsoDateTimeSchema,
    needs: z.string(),
    resolvedAt: IsoDateTimeSchema.optional(),
    resolution: z.string().optional(),
  })
  .strict()

export type BlockageDto = z.infer<typeof BlockageDtoSchema>
