import type { PlanProblem } from '@agentic/domain'
import type { z } from 'zod'
import { API_VERSION } from './common.js'
import type { SchemaIssue } from './issues.js'
import { type MissionFile, MissionFileSchema } from './mission-file.js'

/**
 * O que um planejador pode propor: o CONTEUDO da missao, sem `apiVersion` e sem `kind`.
 *
 * A versao do formato e decisao nossa. Um planejador que pudesse declara-la escolheria o
 * contrato contra o qual sera julgado — e a validacao viraria teatro (MISSION-FORMAT 4).
 *
 * Fora isso o contrato e exatamente o do arquivo: o que passa aqui e o que compila, sem um
 * segundo formato "quase igual" para envelhecer sozinho.
 */
export const MissionPlanSchema = MissionFileSchema.omit({ apiVersion: true, kind: true })

export type MissionPlan = z.infer<typeof MissionPlanSchema>

/**
 * Fecha o documento. `apiVersion` e `kind` entram AQUI, nunca vindos da proposta — e por
 * isso o control plane grava um arquivo que ele mesmo montou, e nao bytes de agente
 * (ADR-0013).
 */
export function missionFileFromPlan(plan: MissionPlan): MissionFile {
  return { ...plan, apiVersion: API_VERSION, kind: 'Mission' }
}

/**
 * Forma canonica: chaves ordenadas, `undefined` removido. Dois planos com o mesmo conteudo
 * em ordem de chave diferente produzem a MESMA string — e o que permite interromper um
 * ciclo de reparo em que o planejador so reescreve o plano anterior.
 *
 * Ordem de ARRAY continua significativa: trocar a ordem das tasks muda o plano que o humano
 * vai ler, entao nao e a mesma proposta.
 */
export function canonicalMissionPlan(plan: MissionPlan): string {
  return JSON.stringify(canonical(plan))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]))
}

/**
 * Recusa do contrato traduzida para o vocabulario do dominio. O planejador nao ve `zod`;
 * ve onde errou.
 */
export function planProblemsOf(issues: readonly SchemaIssue[]): PlanProblem[] {
  return issues.map((issue) => ({ path: issue.path, message: issue.message }))
}

/**
 * Uma linha por problema, colavel tanto no terminal quanto no pedido de correcao. Problema
 * sem caminho e do plano inteiro e sai sem prefixo, em vez de sair com um `: ` orfao.
 */
export function planProblemLines(problems: readonly PlanProblem[]): string[] {
  return problems.map((problem) =>
    problem.path.length === 0 ? problem.message : `${problem.path}: ${problem.message}`,
  )
}
