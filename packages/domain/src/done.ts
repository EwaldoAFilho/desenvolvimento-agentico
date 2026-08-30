import { type AgentIdentity, isSameAgentIdentity } from './agent.js'
import { type EvidenceRef, hasEvidenceOfKind, type ScopeCheck } from './evidence.js'
import type { GateStatus } from './gate.js'
import type { IntegrationStatus } from './integration.js'
import type { ReviewPolicy, ReviewPolicyOutcome, ReviewVerdict } from './review.js'

export interface DoneGateEvidence {
  /** A task declara gate? Ausencia de gate e legitima (P06). */
  readonly required: boolean
  readonly status?: GateStatus
}

export interface DoneReviewEvidence {
  readonly required: boolean
  readonly verdict?: ReviewVerdict
  readonly reviewer?: AgentIdentity
  readonly policy?: ReviewPolicy
  readonly policyOutcome?: ReviewPolicyOutcome
}

export interface DoneEvidence {
  readonly scopeCheck?: ScopeCheck
  readonly gate: DoneGateEvidence
  readonly review: DoneReviewEvidence
  readonly executor?: AgentIdentity
  readonly integration?: IntegrationStatus
  readonly evidence?: readonly EvidenceRef[]
}

export const DONE_FAILURE_REASONS = [
  'SCOPE_NOT_OBSERVED',
  'SCOPE_VIOLATION',
  'GATE_NOT_EXECUTED',
  'GATE_NOT_PASSED',
  'REVIEW_MISSING',
  'REVIEW_NOT_PASSED',
  'REVIEWER_IS_EXECUTOR',
  'REVIEW_POLICY_NOT_SATISFIED',
  'INTEGRATION_NOT_MERGED',
  'EVIDENCE_MISSING',
] as const
export type DoneFailureReason = (typeof DONE_FAILURE_REASONS)[number]

export type DoneCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DoneFailureReason; readonly detail: string }

function fail(reason: DoneFailureReason, detail: string): DoneCheck {
  return { ok: false, reason, detail }
}

/**
 * P06. DONE e predicado sobre registros persistidos, nunca opiniao do agente:
 *
 *   scopeCheck = PASS
 *   ∧ (gate ausente ∨ gate = PASS)
 *   ∧ (¬requireReview ∨ (review = PASS ∧ reviewer ≠ executor))
 *   ∧ integracao = MERGED
 *   ∧ evidencia persistida e referenciavel
 */
export function isDone(evidence: DoneEvidence): DoneCheck {
  if (evidence.scopeCheck === undefined) {
    return fail('SCOPE_NOT_OBSERVED', 'sem Observation: o escopo nao foi apurado')
  }
  if (evidence.scopeCheck !== 'PASS') {
    return fail('SCOPE_VIOLATION', 'a tentativa escreveu fora de touches')
  }

  if (evidence.gate.required) {
    if (evidence.gate.status === undefined) {
      return fail('GATE_NOT_EXECUTED', 'a task declara gate e nao ha GateExecution')
    }
    if (evidence.gate.status !== 'PASS') {
      return fail('GATE_NOT_PASSED', `gate terminou ${evidence.gate.status}`)
    }
  }

  if (evidence.review.required) {
    const { verdict, reviewer, policy, policyOutcome } = evidence.review
    if (verdict === undefined || reviewer === undefined) {
      return fail('REVIEW_MISSING', 'requireReview = true e nao ha revisao registrada')
    }
    if (verdict !== 'PASS') {
      return fail('REVIEW_NOT_PASSED', `veredito da revisao foi ${verdict}`)
    }
    const executor = evidence.executor
    if (executor !== undefined && isSameAgentIdentity(reviewer, executor)) {
      return fail('REVIEWER_IS_EXECUTOR', 'I3: autor nao e revisor')
    }
    if (policy === 'cross-provider-required') {
      if (policyOutcome === 'downgraded') {
        return fail('REVIEW_POLICY_NOT_SATISFIED', 'I10: cross-provider-required nunca rebaixa')
      }
      if (executor !== undefined && reviewer.providerId === executor.providerId) {
        return fail(
          'REVIEW_POLICY_NOT_SATISFIED',
          'cross-provider-required exige fornecedor diferente do executor',
        )
      }
    }
  }

  if (evidence.integration !== 'MERGED') {
    return fail(
      'INTEGRATION_NOT_MERGED',
      `integracao esta ${evidence.integration ?? 'ausente'}, e preciso MERGED`,
    )
  }

  const refs = evidence.evidence ?? []
  if (!hasEvidenceOfKind(refs, 'scope')) {
    return fail('EVIDENCE_MISSING', 'falta EvidenceRef de escopo')
  }
  if (evidence.gate.required && !hasEvidenceOfKind(refs, 'gate')) {
    return fail('EVIDENCE_MISSING', 'falta EvidenceRef de gate')
  }
  if (evidence.review.required && !hasEvidenceOfKind(refs, 'review')) {
    return fail('EVIDENCE_MISSING', 'falta EvidenceRef de revisao')
  }

  return { ok: true }
}

export function assertDone(evidence: DoneEvidence): void {
  const check = isDone(evidence)
  if (!check.ok) throw new Error(`P06 nao satisfeito (${check.reason}): ${check.detail}`)
}

export function requiredEvidenceKinds(evidence: DoneEvidence): EvidenceRef['kind'][] {
  const kinds: EvidenceRef['kind'][] = ['scope']
  if (evidence.gate.required) kinds.push('gate')
  if (evidence.review.required) kinds.push('review')
  return kinds
}
