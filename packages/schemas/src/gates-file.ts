import { z } from 'zod'
import {
  ApiVersionSchema,
  GateCommandSchema,
  GateIdSchema,
  NonEmptyStringSchema,
} from './common.js'

export const GateProfileSchema = z
  .object({
    commands: z.array(GateCommandSchema).min(1, 'um perfil de gate precisa de ao menos um comando'),
  })
  .strict()

export type GateProfileConfig = z.infer<typeof GateProfileSchema>

/** Allowlist explicita: nenhuma variavel fora dela chega ao processo filho (P08/P17). */
export const GatesEnvSchema = z
  .object({
    allow: z.array(NonEmptyStringSchema).default([]),
  })
  .strict()
  .default({})

export const GatesFileSchema = z
  .object({
    apiVersion: ApiVersionSchema,
    kind: z.literal('Gates'),
    profiles: z.record(GateIdSchema, GateProfileSchema),
    env: GatesEnvSchema,
  })
  .strict()

export type GatesFile = z.infer<typeof GatesFileSchema>
