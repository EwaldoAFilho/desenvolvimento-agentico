import { type AgentIdentity, isSameAgentIdentity } from './agent.js'
import { UnresolvedReviewPolicyError } from './errors.js'
import type { EvidenceRef } from './evidence.js'
import type { AttemptId, GateId } from './ids.js'
import type { Risk } from './mission.js'
import type { PathScope } from './path-scope.js'

export const REVIEW_POLICIES = [
  'fresh-session',
  'cross-provider-preferred',
  'cross-provider-required',
] as const
export type ReviewPolicy = (typeof REVIEW_POLICIES)[number]

export function isReviewPolicy(value: unknown): value is ReviewPolicy {
  return typeof value === 'string' && (REVIEW_POLICIES as readonly string[]).includes(value)
}

export const REVIEW_VERDICTS = ['PASS', 'FAIL', 'ESCALATE'] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

export type ReviewPolicyOutcome = 'satisfied' | 'downgraded'

export type FindingSeverity = 'info' | 'warning' | 'error'

export interface ReviewFinding {
  readonly severity: FindingSeverity
  readonly path?: string
  readonly line?: number
  readonly message: string
  readonly evidenceRef?: EvidenceRef
}

/** O revisor recebe evidencia, nunca a narrativa do executor (P07). */
export interface ReviewInput {
  readonly objective: string
  readonly validation: readonly string[]
  readonly constraints: readonly string[]
  readonly touches: readonly PathScope[]
  readonly diffRef?: string
  readonly gateExecutionIds: readonly string[]
  readonly gateIds: readonly GateId[]
}

export interface Review {
  readonly id: string
  readonly attemptId: AttemptId
  readonly reviewer: AgentIdentity
  readonly input: ReviewInput
  readonly verdict: ReviewVerdict
  readonly findings: readonly ReviewFinding[]
  readonly rationale: string
  readonly durationMs: number
  readonly policy: ReviewPolicy
  readonly policyOutcome: ReviewPolicyOutcome
  readonly policyOutcomeReason?: string
}

export function requiresCrossProvider(policy: ReviewPolicy): boolean {
  return policy === 'cross-provider-required'
}

export function prefersCrossProvider(policy: ReviewPolicy): boolean {
  return policy === 'cross-provider-preferred' || policy === 'cross-provider-required'
}

export type ReviewPolicySource = 'task' | 'mission-defaults' | 'project-by-risk' | 'project-default'

export interface ResolvedReviewPolicy {
  readonly policy: ReviewPolicy
  readonly source: ReviewPolicySource
}

/**
 * O dominio NAO conhece o mapa risco->politica: ele chega como parametro, vindo de
 * `project.yaml` (DOMAIN-MODEL 3.6.1).
 */
export interface ReviewPolicyResolutionInput {
  readonly task: { readonly reviewPolicy?: ReviewPolicy; readonly risk?: Risk }
  readonly missionDefaults?: { readonly reviewPolicy?: ReviewPolicy }
  readonly projectPolicy?: {
    readonly byRisk?: Readonly<Partial<Record<Risk, ReviewPolicy>>>
    readonly default?: ReviewPolicy
  }
}

/** Precedencia: task > mission.defaults > project.byRisk[risk] > project.default. */
export function resolveReviewPolicy(input: ReviewPolicyResolutionInput): ResolvedReviewPolicy {
  const fromTask = input.task.reviewPolicy
  if (fromTask !== undefined) return { policy: fromTask, source: 'task' }

  const fromMission = input.missionDefaults?.reviewPolicy
  if (fromMission !== undefined) return { policy: fromMission, source: 'mission-defaults' }

  const risk = input.task.risk
  const byRisk = risk === undefined ? undefined : input.projectPolicy?.byRisk?.[risk]
  if (byRisk !== undefined) return { policy: byRisk, source: 'project-by-risk' }

  const fromProject = input.projectPolicy?.default
  if (fromProject !== undefined) return { policy: fromProject, source: 'project-default' }

  throw new UnresolvedReviewPolicyError(
    'nenhum dos quatro niveis (task, mission.defaults, project.byRisk, project.default) definiu politica',
  )
}

export type ReviewerRejection = 'CROSS_PROVIDER_UNAVAILABLE' | 'NO_REVIEWER_AVAILABLE'

export interface ReviewerSelected {
  readonly ok: true
  readonly reviewer: AgentIdentity
  readonly policy: ReviewPolicy
  readonly effectivePolicy: ReviewPolicy
  readonly policyOutcome: ReviewPolicyOutcome
  readonly reason?: string
}

export interface ReviewerUnavailable {
  readonly ok: false
  readonly policy: ReviewPolicy
  readonly reason: ReviewerRejection
}

export type ReviewerSelection = ReviewerSelected | ReviewerUnavailable

/** Desempate deterministico: perfil diferente do executor primeiro, depois ordem recebida. */
function pick(candidates: readonly AgentIdentity[], executor: AgentIdentity): AgentIdentity {
  const distinctProfile = candidates.find((c) => c.profileId !== executor.profileId)
  const chosen = distinctProfile ?? candidates[0]
  if (chosen === undefined) throw new Error('pick chamado sem candidatos')
  return chosen
}

/**
 * I10: `cross-provider-required` nunca rebaixa. `cross-provider-preferred` rebaixa para
 * `fresh-session` e devolve `policyOutcome: 'downgraded'` para o registro obrigatorio.
 */
export function selectReviewer(
  candidates: readonly AgentIdentity[],
  executor: AgentIdentity,
  policy: ReviewPolicy,
): ReviewerSelection {
  const eligible = candidates.filter((candidate) => !isSameAgentIdentity(candidate, executor))
  const crossProvider = eligible.filter((candidate) => candidate.providerId !== executor.providerId)

  if (policy === 'cross-provider-required') {
    if (crossProvider.length === 0) {
      return { ok: false, policy, reason: 'CROSS_PROVIDER_UNAVAILABLE' }
    }
    return {
      ok: true,
      reviewer: pick(crossProvider, executor),
      policy,
      effectivePolicy: policy,
      policyOutcome: 'satisfied',
    }
  }

  if (policy === 'cross-provider-preferred' && crossProvider.length > 0) {
    return {
      ok: true,
      reviewer: pick(crossProvider, executor),
      policy,
      effectivePolicy: policy,
      policyOutcome: 'satisfied',
    }
  }

  if (eligible.length === 0) {
    return { ok: false, policy, reason: 'NO_REVIEWER_AVAILABLE' }
  }

  const downgraded = policy === 'cross-provider-preferred'
  return {
    ok: true,
    reviewer: pick(eligible, executor),
    policy,
    effectivePolicy: 'fresh-session',
    policyOutcome: downgraded ? 'downgraded' : 'satisfied',
    reason: downgraded ? 'CROSS_PROVIDER_UNAVAILABLE' : undefined,
  }
}
