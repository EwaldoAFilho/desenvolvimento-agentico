import type { RunStatus } from '@agentic/domain'
import { Budget } from './capacity.js'
import { planExecutions } from './execute.js'
import { ScopeLedger } from './locks.js'
import { buildPlan } from './priority.js'
import { planReviews } from './review.js'
import type { SchedulerDecision, SchedulerInput } from './types.js'

/** Transicao 4 (READY -> RUNNING) exige o run em `RUNNING`. */
function dispatchesExecution(status: RunStatus): boolean {
  return status === 'RUNNING'
}

/**
 * `PAUSED` para de encher, mas deixa a tentativa em voo terminar (STATE-MACHINES 2.1) — e
 * uma tentativa em `VERIFYING` so termina com a revisao que ela exige.
 */
function dispatchesReview(status: RunStatus): boolean {
  return status === 'RUNNING' || status === 'PAUSED'
}

/**
 * Funcao pura de decisao (ARCHITECTURE 3.2). Nao despacha, nao adquire lock, nao consulta
 * registry e nao le relogio: recebe o retrato e devolve o que deve acontecer.
 *
 * Ordem dos criterios: revisoes pendentes primeiro (drenar antes de encher), depois as
 * `READY` que sobrevivem a lock, perfil e capacidade — as duas levas compartilham o mesmo
 * orcamento de vagas.
 */
export function select(input: SchedulerInput): SchedulerDecision[] {
  const plan = buildPlan(input.graph, input.specs)
  const budget = new Budget(input.policies, input.capacity)
  const decisions: SchedulerDecision[] = []

  if (dispatchesReview(input.runStatus)) {
    decisions.push(...planReviews(input, plan, budget))
  }
  if (dispatchesExecution(input.runStatus)) {
    decisions.push(...planExecutions(input, plan, budget, new ScopeLedger(input.locks)))
  }

  return decisions
}
