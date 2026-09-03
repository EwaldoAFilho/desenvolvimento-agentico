import {
  AGENT_PROFILE_ID_PATTERN,
  AGENT_ROLES,
  GATE_ID_PATTERN,
  isPathScope,
  MISSION_ID_PATTERN,
  PHASE_ID_PATTERN,
  PROVIDER_ID_PATTERN,
  REVIEW_POLICIES,
  RISKS,
  TASK_ID_PATTERN,
} from '@agentic/domain'
import { z } from 'zod'

/** Unica versao aceita. Versao desconhecida e recusada, nunca adivinhada (MISSION-FORMAT 4). */
export const API_VERSION = 'agentic/v1'

export const ApiVersionSchema = z.literal(API_VERSION)

export const NonEmptyStringSchema = z.string().trim().min(1, 'nao pode ser vazio')

export const PositiveIntSchema = z.number().int().positive()

export const NonNegativeIntSchema = z.number().int().min(0)

export const MissionIdSchema = z
  .string()
  .regex(MISSION_ID_PATTERN, `MissionId deve casar ${MISSION_ID_PATTERN.source}`)

export const TaskIdSchema = z
  .string()
  .regex(TASK_ID_PATTERN, `TaskId deve casar ${TASK_ID_PATTERN.source}`)

export const PhaseIdSchema = z
  .string()
  .regex(PHASE_ID_PATTERN, `PhaseId deve casar ${PHASE_ID_PATTERN.source}`)

export const GateIdSchema = z
  .string()
  .regex(GATE_ID_PATTERN, `GateId deve casar ${GATE_ID_PATTERN.source}`)

export const AgentProfileIdSchema = z
  .string()
  .regex(AGENT_PROFILE_ID_PATTERN, `AgentProfileId deve casar ${AGENT_PROFILE_ID_PATTERN.source}`)

export const ProviderIdSchema = z
  .string()
  .regex(PROVIDER_ID_PATTERN, `ProviderId deve casar ${PROVIDER_ID_PATTERN.source}`)

/**
 * Forma do caminho (POSIX relativo, sem glob, sem `..`) e validada aqui para que o
 * mapeamento para o dominio nao possa lancar. Contencao no repositorio e `denyPaths`
 * continuam sendo semantica do compilador (DA1008).
 *
 * A saida continua `string`, nao `PathScope`: quem normaliza e o dominio, em
 * `toMissionSpec`. Marcar aqui seria afirmar uma normalizacao que ainda nao aconteceu.
 */
export const PathScopeSchema = z
  .string()
  .refine(
    (value): boolean => isPathScope(value),
    'caminho POSIX relativo, sem glob, sem ".." e sem raiz absoluta',
  )

/**
 * Caminho relativo a raiz do projeto, na fronteira de saida. Existe para que caminho
 * absoluto do HOST nunca atravesse: o navegador nao precisa saber onde o repositorio mora
 * no disco, e o payload deixa de carregar o nome do usuario (ARCHITECTURE 9).
 */
export const RepoRelativePathSchema = z
  .string()
  .refine(
    (value): boolean => isPathScope(value),
    'caminho relativo a raiz do projeto, sem ".." e sem raiz absoluta',
  )

export const RiskSchema = z.enum(RISKS)

export const ReviewPolicySchema = z.enum(REVIEW_POLICIES)

export const AgentRoleSchema = z.enum(AGENT_ROLES)

/** Comando executavel: mesma forma em `gates.yaml` e em `execution.workspaceSetup`. */
export const GateCommandSchema = z
  .object({
    run: NonEmptyStringSchema,
    cwd: NonEmptyStringSchema.optional(),
    timeoutMs: PositiveIntSchema.optional(),
    required: z.boolean().optional(),
  })
  .strict()

export type GateCommandConfig = z.infer<typeof GateCommandSchema>

/**
 * Linha de texto livre (`scope`, `constraints`, `acceptanceCriteria`, `validation`).
 *
 * YAML le `- Sem API key: agente roda por CLI local` como mapa de uma chave, porque `: `
 * sem aspas abre um par. O campo e prosa escrita por humano, entao a fronteira recompoe a
 * linha em vez de recusar o arquivo — recusar aqui seria exigir do autor conhecimento de
 * YAML que o formato nao pede.
 */
export const FreeTextLineSchema = z.preprocess(rejoinAccidentalMap, NonEmptyStringSchema)

function rejoinAccidentalMap(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const entries = Object.entries(value as Record<string, unknown>)
  const only = entries[0]
  if (entries.length !== 1 || only === undefined) return value
  const [key, text] = only
  return typeof text === 'string' ? `${key}: ${text}` : value
}
