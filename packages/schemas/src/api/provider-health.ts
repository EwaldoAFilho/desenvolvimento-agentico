import { PROVIDER_DIAGNOSTIC_KINDS } from '@agentic/domain'
import { z } from 'zod'
import { NonNegativeIntSchema, ProviderIdSchema } from '../common.js'
import { IsoDateTimeSchema } from './common.js'

/**
 * `unknown` e valor de primeira classe: quando a CLI nao permite observar instalacao ou
 * autenticacao de forma confiavel, reportamos `unknown` — a UI mostra `unknown`, nunca
 * pinta de verde por otimismo (DASHBOARD 5.1).
 */
export const TristateSchema = z.union([z.boolean(), z.literal('unknown')])

export type Tristate = z.infer<typeof TristateSchema>

/** `unknown` viaja como literal no JSON: nao vira `null` nem some do payload. */
export const UnknownableStringSchema = z.union([z.literal('unknown'), z.string()])

/** Catalogo unico: o enum vem do dominio, nao de uma copia que envelhece sozinha. */
export const ProviderDiagnosticKindSchema = z.enum(PROVIDER_DIAGNOSTIC_KINDS)

export type ProviderDiagnosticKind = z.infer<typeof ProviderDiagnosticKindSchema>

/**
 * Diagnostico do ambiente do provider: por que nao da para usar e o que consertar.
 * Nao carrega saida de CLI nem dado pessoal — caminho, motivo e conserto, so isso.
 */
export const ProviderDiagnosticDtoSchema = z
  .object({
    kind: ProviderDiagnosticKindSchema,
    detail: z.string(),
    target: z.string().optional(),
    remediation: z.string().optional(),
  })
  .strict()

export type ProviderDiagnosticDto = z.infer<typeof ProviderDiagnosticDtoSchema>

export const ProviderHealthDtoSchema = z
  .object({
    providerId: ProviderIdSchema,
    installed: TristateSchema,
    ready: TristateSchema,
    version: z.string(),
    detail: z.string(),
    running: NonNegativeIntSchema,
    capacity: NonNegativeIntSchema.nullable(),
    probedAt: IsoDateTimeSchema.optional(),
    /** Caminho absoluto do executavel resolvido, ou o literal `unknown`. */
    resolvedPath: UnknownableStringSchema.optional(),
    /** COMO a prontidao foi apurada — inclusive quando a resposta foi `unknown`. */
    readinessSource: z.string().optional(),
    diagnostic: ProviderDiagnosticDtoSchema.optional(),
  })
  .strict()

export type ProviderHealthDto = z.infer<typeof ProviderHealthDtoSchema>
