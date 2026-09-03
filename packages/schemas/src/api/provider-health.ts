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

/**
 * Os cinco estados de um fornecedor. Existem porque `installed` e `ready` sozinhos deixam o
 * operador adivinhando: "nao instalado" e "instalado, prontidao nao apurada" tem conserto
 * diferente, e `unknown` nao e nenhum dos dois (ADR-0010, DASHBOARD 5.1).
 *
 * Moram no contrato, e nao na CLI, porque terminal e dashboard precisam pintar a MESMA
 * situacao do MESMO jeito. Duas derivacoes com a mesma intencao divergem — e a divergencia
 * aparece como um fornecedor verde num lugar e amarelo no outro (ADR-0016).
 */
export const PROVIDER_STATES = [
  'READY',
  'NOT_READY',
  'INSTALLED',
  'NOT_INSTALLED',
  'UNKNOWN',
] as const

export type ProviderState = (typeof PROVIDER_STATES)[number]

export const ProviderStateSchema = z.enum(PROVIDER_STATES)

/** O literal que viaja no JSON quando a resposta nao foi apurada. */
export const UNKNOWN = 'unknown'

/**
 * Total e sem ambiguidade:
 *
 * - `NOT_INSTALLED` — nao ha executavel; nada mais importa ate isso mudar.
 * - `NOT_READY`     — existe (ou pode existir), mas a sonda de sessao REPROVOU.
 * - `UNKNOWN`       — a propria instalacao nao foi apurada.
 * - `READY`         — instalado e sonda de sessao aprovou.
 * - `INSTALLED`     — instalado, prontidao nao apurada. Nao e READY, e nao e falha.
 */
export function providerStateOf(health: ProviderHealthDto): ProviderState {
  if (health.installed === false) return 'NOT_INSTALLED'
  if (health.ready === false) return 'NOT_READY'
  if (health.installed === UNKNOWN) return 'UNKNOWN'
  if (health.ready === true) return 'READY'
  return 'INSTALLED'
}
