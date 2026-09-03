import {
  type ResolvedReviewPolicy,
  type ReviewerSelection,
  resolveReviewPolicy,
  selectReviewer,
  UnresolvedReviewPolicyError,
} from '@agentic/domain'
import type { Budget } from './capacity.js'
import { type GraphPlan, sortByPriority } from './priority.js'
import type { PendingReview, SchedulerDecision, SchedulerInput } from './types.js'

/**
 * Drenar antes de encher (ARCHITECTURE 3.2, item 1). Roda antes de qualquer despacho de
 * execucao e consome as mesmas vagas — sem isso todo slot vira executor, ninguem revisa e
 * o run se estrangula.
 */
export function planReviews(
  input: SchedulerInput,
  plan: GraphPlan,
  budget: Budget,
): SchedulerDecision[] {
  const decisions: SchedulerDecision[] = []
  const ordered = sortByPriority(plan, input.pendingReviews, (review) => review.taskId)

  for (const pending of ordered) {
    const resolved = resolvePolicy(input, plan, pending)
    if (resolved === undefined) continue

    // Viabilidade e questao de politica: avaliada sobre todos os candidatos, sem capacidade.
    const feasible = selectReviewer(input.reviewCandidates, pending.executor, resolved.policy)
    // Viabilidade avaliada sobre TODOS os candidatos declarados, sem olhar capacidade: o que
    // reprova aqui e permanente. I10 (`cross-provider-required` sem segundo fornecedor apto)
    // nunca rebaixa; revisor de ENSAIO nunca vira revisor real; e projeto que nao declarou
    // revisor nenhum nao ganha um esperando. Os tres viram BLOCKED com motivo — antes, o
    // terceiro caso ficava girando em `VERIFYING` para sempre, com a tela sem dizer nada.
    // Falta de VAGA nao passa por aqui: e medida abaixo, no orcamento, e essa sim espera.
    if (!feasible.ok) {
      decisions.push({
        kind: 'block-task',
        taskId: pending.taskId,
        reason: feasible.reason,
        policy: resolved.policy,
      })
      continue
    }

    if (!budget.hasSlot('reviewer')) continue

    const affordable = input.reviewCandidates.filter((candidate) =>
      budget.hasProvider(candidate.providerId),
    )
    const chosen = selectReviewer(affordable, pending.executor, resolved.policy)
    if (!chosen.ok) continue
    // Vaga ocupada nao rebaixa politica: falta de capacidade nao e falta de fornecedor.
    if (downgradedOnlyByCapacity(feasible, chosen)) continue
    if (!budget.reserve('reviewer', chosen.reviewer.providerId)) continue

    decisions.push({
      kind: 'dispatch-reviewer',
      taskId: pending.taskId,
      attemptId: pending.attemptId,
      reviewer: chosen.reviewer,
      policy: chosen.policy,
      policyOutcome: chosen.policyOutcome,
    })
  }

  return decisions
}

function downgradedOnlyByCapacity(feasible: ReviewerSelection, chosen: ReviewerSelection): boolean {
  if (!feasible.ok || !chosen.ok) return false
  return feasible.policyOutcome === 'satisfied' && chosen.policyOutcome === 'downgraded'
}

/** Politica sem nenhum nivel definido nao vira default silencioso: a revisao apenas espera. */
function resolvePolicy(
  input: SchedulerInput,
  plan: GraphPlan,
  pending: PendingReview,
): ResolvedReviewPolicy | undefined {
  const spec = plan.specOf(pending.taskId)
  try {
    return resolveReviewPolicy({
      task: { reviewPolicy: spec?.reviewPolicy, risk: spec?.risk },
      missionDefaults: input.missionDefaults,
      projectPolicy: input.projectReviewPolicy,
    })
  } catch (error) {
    if (error instanceof UnresolvedReviewPolicyError) return undefined
    throw error
  }
}
