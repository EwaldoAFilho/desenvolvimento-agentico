import { z } from 'zod'
import {
  AgentProfileIdSchema,
  ApiVersionSchema,
  FreeTextLineSchema,
  GateIdSchema,
  MissionIdSchema,
  NonEmptyStringSchema,
  PathScopeSchema,
  PhaseIdSchema,
  ReviewPolicySchema,
  RiskSchema,
  TaskIdSchema,
} from './common.js'

export const MAX_TASKS_PER_MISSION = 200

export const MissionDefaultsSchema = z
  .object({
    requireReview: z.boolean().optional(),
    maxAttempts: z.number().int().min(1).optional(),
    gate: GateIdSchema.optional(),
    agentProfile: AgentProfileIdSchema.optional(),
    reviewPolicy: ReviewPolicySchema.optional(),
  })
  .strict()

export type MissionFileDefaults = z.infer<typeof MissionDefaultsSchema>

export const MissionPhaseSchema = z
  .object({
    id: PhaseIdSchema,
    title: NonEmptyStringSchema,
    order: z.number().int().optional(),
  })
  .strict()

export type MissionFilePhase = z.infer<typeof MissionPhaseSchema>

/**
 * `touches` e opcional no schema de proposito: "obrigatorio para task que altera codigo"
 * so pode ser decidido com o projeto em maos — e DA1008/DA2002 do compilador.
 */
export const MissionTaskSchema = z
  .object({
    id: TaskIdSchema,
    phase: PhaseIdSchema,
    title: NonEmptyStringSchema,
    objective: NonEmptyStringSchema,
    description: z.string().optional(),
    dependencies: z.array(TaskIdSchema).default([]),
    touches: z.array(PathScopeSchema).optional(),
    reads: z.array(PathScopeSchema).optional(),
    validation: z.array(FreeTextLineSchema).optional(),
    gate: GateIdSchema.optional(),
    requireReview: z.boolean().optional(),
    maxAttempts: z.number().int().min(1).optional(),
    risk: RiskSchema.default('medium'),
    estimate: z.number().positive().default(1),
    agentProfile: AgentProfileIdSchema.optional(),
    reviewPolicy: ReviewPolicySchema.optional(),
  })
  .strict()

export type MissionFileTask = z.infer<typeof MissionTaskSchema>

const PhasesSchema = z
  .array(MissionPhaseSchema)
  .min(1, 'declare ao menos uma fase')
  .superRefine((phases, ctx) => {
    const seen = new Set<string>()
    phases.forEach((phase, index) => {
      if (seen.has(phase.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `fase com id repetido: ${phase.id}`,
        })
      }
      seen.add(phase.id)
    })
  })

export const MissionFileSchema = z
  .object({
    apiVersion: ApiVersionSchema,
    kind: z.literal('Mission'),
    id: MissionIdSchema,
    title: z.string().trim().min(1).max(120),
    objective: NonEmptyStringSchema,
    description: z.string().optional(),
    scope: z.array(FreeTextLineSchema).optional(),
    outOfScope: z.array(FreeTextLineSchema).optional(),
    constraints: z.array(FreeTextLineSchema).optional(),
    acceptanceCriteria: z.array(FreeTextLineSchema).min(1, 'declare ao menos um criterio'),
    defaults: MissionDefaultsSchema.optional(),
    phases: PhasesSchema,
    tasks: z.array(MissionTaskSchema).min(1).max(MAX_TASKS_PER_MISSION),
    missionGate: GateIdSchema.optional(),
  })
  .strict()

export type MissionFile = z.infer<typeof MissionFileSchema>
