import { createHash } from 'node:crypto'
import type {
  EvidenceRef,
  GateExecution,
  IntegrationResult,
  Observation,
  Review,
} from '@agentic/domain'

/** Digest do registro citado: o humano confere que a evidencia nao mudou depois. */
export function digestOf(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'null', 'utf8')
    .digest('hex')
}

export function scopeEvidence(
  sourceId: string,
  observation: Observation,
  artifactPath?: string,
): EvidenceRef {
  return {
    kind: 'scope',
    sourceId,
    artifactPath,
    digest: digestOf({
      files: observation.filesChanged,
      scopeCheck: observation.scopeCheck,
      commit: observation.commit,
    }),
  }
}

export function gateEvidence(execution: GateExecution): EvidenceRef {
  return {
    kind: 'gate',
    sourceId: execution.id,
    digest: digestOf({
      gateId: execution.gateId,
      status: execution.status,
      results: execution.results,
    }),
  }
}

export function reviewEvidence(review: Review): EvidenceRef {
  return {
    kind: 'review',
    sourceId: review.id,
    digest: digestOf({
      reviewer: review.reviewer.sessionRef,
      verdict: review.verdict,
      policy: review.policy,
      policyOutcome: review.policyOutcome,
    }),
  }
}

export function integrationEvidence(sourceId: string, result: IntegrationResult): EvidenceRef {
  return {
    kind: 'integration',
    sourceId,
    digest: digestOf({ status: result.status, commit: result.commit?.sha }),
  }
}
