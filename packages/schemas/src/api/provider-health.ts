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
  })
  .strict()

export type ProviderHealthDto = z.infer<typeof ProviderHealthDtoSchema>
