import { z } from 'zod'
import { MissionIdSchema, NonEmptyStringSchema, TaskIdSchema } from '../common.js'

/** Aprovar e ato humano registrado: nao existe caminho de aprovacao automatica. */
export const ApproveMissionCommandSchema = z
  .object({
    actor: NonEmptyStringSchema,
    note: z.string().optional(),
  })
  .strict()

export type ApproveMissionCommand = z.infer<typeof ApproveMissionCommandSchema>

/**
 * `acceptWarnings` e obrigatorio e explicito: com WARNING pendente a partida exige aceite,
 * e o aceite fica gravado no evento `run.started` (DASHBOARD 2.1).
 */
export const StartRunCommandSchema = z
  .object({
    missionPath: NonEmptyStringSchema.optional(),
    missionId: MissionIdSchema.optional(),
    acceptWarnings: z.boolean(),
    actor: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((command, ctx) => {
    const given = [command.missionPath, command.missionId].filter((v) => v !== undefined).length
    if (given !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['missionPath'],
        message: 'informe exatamente um entre `missionPath` e `missionId`',
      })
    }
  })

export type StartRunCommand = z.infer<typeof StartRunCommandSchema>

export const TaskCommandSchema = z
  .object({
    taskId: TaskIdSchema,
    actor: NonEmptyStringSchema.optional(),
    note: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict()

export type TaskCommand = z.infer<typeof TaskCommandSchema>

export const RetryTaskCommandSchema = TaskCommandSchema

export type RetryTaskCommand = z.infer<typeof RetryTaskCommandSchema>

/** Desbloquear exige nota; pular exige motivo (DASHBOARD 7). Atrito deliberado. */
export const UnblockTaskCommandSchema = z
  .object({
    taskId: TaskIdSchema,
    actor: NonEmptyStringSchema.optional(),
    note: NonEmptyStringSchema,
  })
  .strict()

export type UnblockTaskCommand = z.infer<typeof UnblockTaskCommandSchema>

export const SkipTaskCommandSchema = z
  .object({
    taskId: TaskIdSchema,
    actor: NonEmptyStringSchema.optional(),
    reason: NonEmptyStringSchema,
  })
  .strict()

export type SkipTaskCommand = z.infer<typeof SkipTaskCommandSchema>
