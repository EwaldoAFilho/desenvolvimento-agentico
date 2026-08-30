import { z } from 'zod'
import { MissionIdSchema, NonEmptyStringSchema, NonNegativeIntSchema } from '../common.js'

export const DIAGNOSTIC_SEVERITIES = ['ERROR', 'WARNING', 'INFO'] as const
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number]

export const DIAGNOSTIC_CODE_PATTERN = /^DA\d{4}$/

/**
 * Catalogo fechado por formato (ARCHITECTURE 7.1). `targets` sao os ids ou caminhos
 * citados — o par de tasks em conflito, a task sem gate, o caminho fora do repositorio.
 */
export const DiagnosticDtoSchema = z
  .object({
    code: z.string().regex(DIAGNOSTIC_CODE_PATTERN, 'codigo deve ser DAnnnn'),
    severity: z.enum(DIAGNOSTIC_SEVERITIES),
    message: NonEmptyStringSchema,
    targets: z.array(z.string()),
    hint: z.string().optional(),
  })
  .strict()

export type DiagnosticDto = z.infer<typeof DiagnosticDtoSchema>

export const CompileStatsDtoSchema = z
  .object({
    tasks: NonNegativeIntSchema,
    phases: NonNegativeIntSchema,
    edges: NonNegativeIntSchema,
    errors: NonNegativeIntSchema,
    warnings: NonNegativeIntSchema,
    infos: NonNegativeIntSchema,
    criticalPathLength: NonNegativeIntSchema,
    waves: NonNegativeIntSchema,
    maxParallelism: NonNegativeIntSchema,
  })
  .strict()

export type CompileStatsDto = z.infer<typeof CompileStatsDtoSchema>

export const CompileReportDtoSchema = z
  .object({
    missionId: MissionIdSchema,
    specHash: z.string().optional(),
    /** `false` quando ha qualquer ERROR: nao existe botao de partida nesse caso. */
    ok: z.boolean(),
    diagnostics: z.array(DiagnosticDtoSchema),
    stats: CompileStatsDtoSchema,
  })
  .strict()

export type CompileReportDto = z.infer<typeof CompileReportDtoSchema>
