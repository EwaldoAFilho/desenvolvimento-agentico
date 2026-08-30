import { WORKSPACE_KINDS } from '@agentic/domain'
import { z } from 'zod'
import {
  AgentProfileIdSchema,
  AgentRoleSchema,
  ApiVersionSchema,
  GateCommandSchema,
  GateIdSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  ProviderIdSchema,
  ReviewPolicySchema,
} from './common.js'

export const PROVIDER_KINDS = ['local-cli', 'inprocess'] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export const INTEGRATION_STRATEGIES = ['rebase-merge', 'merge'] as const
export type IntegrationStrategy = (typeof INTEGRATION_STRATEGIES)[number]

export const ESCALATION_TRIGGERS = [
  'attemptsExhausted',
  'scopeViolationRepeated',
  'reviewEscalate',
] as const
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number]

export const ProjectIdentitySchema = z
  .object({
    name: NonEmptyStringSchema,
    repoRoot: NonEmptyStringSchema.default('.'),
  })
  .strict()

/**
 * Sem isto uma worktree recem-criada nao tem node_modules nem .env e todo gate falha
 * (MISSION-FORMAT 2). `link` e symlink a partir da raiz; `commands` e o caso caro.
 */
export const WorkspaceSetupSchema = z
  .object({
    link: z.array(NonEmptyStringSchema).default([]),
    commands: z.array(GateCommandSchema).default([]),
    timeoutMs: PositiveIntSchema.default(600_000),
  })
  .strict()
  .default({})

export type WorkspaceSetup = z.infer<typeof WorkspaceSetupSchema>

export const ProjectExecutionSchema = z
  .object({
    workspace: z.enum(WORKSPACE_KINDS),
    worktreeRoot: NonEmptyStringSchema.default('.agentic/worktrees'),
    maxParallelTasks: PositiveIntSchema,
    maxExecutors: PositiveIntSchema,
    maxReviewers: NonNegativeIntSchema,
    defaultMaxAttempts: z.number().int().min(1),
    attemptTimeoutMinutes: z.number().positive(),
    retryBackoffSeconds: z.number().min(0),
    workspaceSetup: WorkspaceSetupSchema,
  })
  .strict()

export type ProjectExecution = z.infer<typeof ProjectExecutionSchema>

/** O mapa risco->politica e decisao de projeto, nao regra de dominio (ADR-0011). */
export const ReviewPolicyConfigSchema = z
  .object({
    default: ReviewPolicySchema,
    byRisk: z
      .object({
        low: ReviewPolicySchema,
        medium: ReviewPolicySchema,
        high: ReviewPolicySchema,
      })
      .strict(),
  })
  .strict()

export type ReviewPolicyConfig = z.infer<typeof ReviewPolicyConfigSchema>

export const ProjectPoliciesSchema = z
  .object({
    enforceTouches: z.boolean().default(true),
    requireReviewByDefault: z.boolean().default(true),
    denyPaths: z.array(NonEmptyStringSchema).default([]),
    escalateOn: z.array(z.enum(ESCALATION_TRIGGERS)).default([]),
    review: ReviewPolicyConfigSchema,
  })
  .strict()

export type ProjectPolicies = z.infer<typeof ProjectPoliciesSchema>

export const ProjectIntegrationSchema = z
  .object({
    missionBranchPrefix: NonEmptyStringSchema.default('mission/'),
    taskBranchPrefix: NonEmptyStringSchema.default('task/'),
    strategy: z.enum(INTEGRATION_STRATEGIES).default('rebase-merge'),
    autoPush: z.boolean().default(false),
  })
  .strict()
  .default({})

export type ProjectIntegration = z.infer<typeof ProjectIntegrationSchema>

export const AgentProfileConfigSchema = z
  .object({
    role: AgentRoleSchema,
    model: NonEmptyStringSchema.optional(),
    systemContextRef: NonEmptyStringSchema.optional(),
    tags: z.array(NonEmptyStringSchema).default([]),
  })
  .strict()

export type AgentProfileConfig = z.infer<typeof AgentProfileConfigSchema>

/**
 * `maxConcurrent` e obrigatorio: sem capacidade declarada nao ha como honrar I9. `roles`
 * ausente vale por ambos os papeis, mas declarado vazio e erro — provider que nao serve
 * para nada e engano de configuracao.
 */
export const ProviderConfigSchema = z
  .object({
    kind: z.enum(PROVIDER_KINDS),
    command: NonEmptyStringSchema.optional(),
    versionArgs: z.array(z.string()).optional(),
    readinessArgs: z.array(z.string()).optional(),
    maxConcurrent: PositiveIntSchema,
    roles: z
      .array(AgentRoleSchema)
      .min(1, 'declare ao menos um papel')
      .default(['executor', 'reviewer']),
    profiles: z.record(AgentProfileIdSchema, AgentProfileConfigSchema).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.kind === 'local-cli' && config.command === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command'],
        message: 'provider local-cli precisa declarar o executavel em `command`',
      })
    }
  })

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

export const ProvidersConfigSchema = z
  .object({
    default: ProviderIdSchema,
    registry: z
      .record(ProviderIdSchema, ProviderConfigSchema)
      .refine((registry) => Object.keys(registry).length > 0, 'registry nao pode ser vazio'),
  })
  .strict()

export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>

export const ProjectGatesSchema = z
  .object({
    file: NonEmptyStringSchema.default('.agentic/gates.yaml'),
    missionGate: GateIdSchema.optional(),
  })
  .strict()
  .default({})

export const ProjectServerSchema = z
  .object({
    host: NonEmptyStringSchema.default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(4317),
  })
  .strict()
  .default({})

export const ProjectFileSchema = z
  .object({
    apiVersion: ApiVersionSchema,
    kind: z.literal('Project'),
    project: ProjectIdentitySchema,
    execution: ProjectExecutionSchema,
    policies: ProjectPoliciesSchema,
    integration: ProjectIntegrationSchema,
    providers: ProvidersConfigSchema,
    gates: ProjectGatesSchema,
    server: ProjectServerSchema,
  })
  .strict()

export type ProjectFile = z.infer<typeof ProjectFileSchema>
