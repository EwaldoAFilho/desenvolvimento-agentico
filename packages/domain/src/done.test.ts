import { describe, expect, it } from 'vitest'
import { doneEvidence, EXECUTOR, evidenceRefs, identity } from './__fixtures__/builders.js'
import { isDone, requiredEvidenceKinds } from './done.js'

describe('predicado DONE (P06)', () => {
  it('satisfeito com escopo, gate, revisao independente, merge e evidencia', () => {
    expect(isDone(doneEvidence())).toEqual({ ok: true })
  })

  it('sem gate exigido e sem revisao exigida, basta escopo + merge + evidencia', () => {
    const check = isDone(
      doneEvidence({
        gate: { required: false },
        review: { required: false },
        evidence: evidenceRefs(['scope']),
      }),
    )
    expect(check).toEqual({ ok: true })
  })

  it('gate exigido e ausente reprova', () => {
    const check = isDone(doneEvidence({ gate: { required: true } }))
    expect(check).toMatchObject({ ok: false, reason: 'GATE_NOT_EXECUTED' })
  })

  it.each(['FAIL', 'ERROR', 'TIMEOUT'] as const)('gate %s reprova', (status) => {
    expect(isDone(doneEvidence({ gate: { required: true, status } }))).toMatchObject({
      ok: false,
      reason: 'GATE_NOT_PASSED',
    })
  })

  it('gate ausente na definicao nao reprova mesmo sem status', () => {
    const check = isDone(
      doneEvidence({ gate: { required: false }, evidence: evidenceRefs(['scope', 'review']) }),
    )
    expect(check).toEqual({ ok: true })
  })

  it('gate exigido com revisao dispensada exige evidencia de escopo e gate, nao de revisao', () => {
    expect(
      isDone(
        doneEvidence({
          gate: { required: true, status: 'PASS' },
          review: { required: false },
          evidence: evidenceRefs(['scope', 'gate']),
        }),
      ),
    ).toEqual({ ok: true })
    expect(
      isDone(
        doneEvidence({
          gate: { required: true, status: 'PASS' },
          review: { required: false },
          evidence: evidenceRefs(['scope']),
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'EVIDENCE_MISSING' })
    expect(
      requiredEvidenceKinds(
        doneEvidence({ gate: { required: true, status: 'PASS' }, review: { required: false } }),
      ),
    ).toEqual(['scope', 'gate'])
  })

  it('revisao exigida e ausente reprova', () => {
    expect(isDone(doneEvidence({ review: { required: true } }))).toMatchObject({
      ok: false,
      reason: 'REVIEW_MISSING',
    })
  })

  it.each(['FAIL', 'ESCALATE'] as const)('veredito %s reprova', (verdict) => {
    const check = isDone(
      doneEvidence({
        review: { required: true, verdict, reviewer: identity('session-reviewer', 'p-beta') },
      }),
    )
    expect(check).toMatchObject({ ok: false, reason: 'REVIEW_NOT_PASSED' })
  })

  it('revisor igual ao executor reprova (I3 / P07)', () => {
    const check = isDone(
      doneEvidence({
        review: { required: true, verdict: 'PASS', reviewer: EXECUTOR },
      }),
    )
    expect(check).toMatchObject({ ok: false, reason: 'REVIEWER_IS_EXECUTOR' })
  })

  it('cross-provider-required com revisor do mesmo fornecedor reprova', () => {
    const check = isDone(
      doneEvidence({
        review: {
          required: true,
          verdict: 'PASS',
          reviewer: identity('outra-sessao', 'p-alpha', 'reviewer'),
          policy: 'cross-provider-required',
          policyOutcome: 'satisfied',
        },
      }),
    )
    expect(check).toMatchObject({ ok: false, reason: 'REVIEW_POLICY_NOT_SATISFIED' })
  })

  it('cross-provider-required rebaixada reprova (I10)', () => {
    const check = isDone(
      doneEvidence({
        review: {
          required: true,
          verdict: 'PASS',
          reviewer: identity('outra-sessao', 'p-beta', 'reviewer'),
          policy: 'cross-provider-required',
          policyOutcome: 'downgraded',
        },
      }),
    )
    expect(check).toMatchObject({ ok: false, reason: 'REVIEW_POLICY_NOT_SATISFIED' })
  })

  it('escopo nao apurado e escopo violado tem motivos distintos', () => {
    expect(isDone(doneEvidence({ scopeCheck: undefined }))).toMatchObject({
      ok: false,
      reason: 'SCOPE_NOT_OBSERVED',
    })
    expect(isDone(doneEvidence({ scopeCheck: 'VIOLATION' }))).toMatchObject({
      ok: false,
      reason: 'SCOPE_VIOLATION',
    })
  })

  it.each(['CONFLICT', 'SKIPPED', undefined] as const)('integracao %s reprova', (integration) => {
    expect(isDone(doneEvidence({ integration }))).toMatchObject({
      ok: false,
      reason: 'INTEGRATION_NOT_MERGED',
    })
  })

  it('falta de EvidenceRef de cada tipo exigido reprova (I6)', () => {
    expect(isDone(doneEvidence({ evidence: [] }))).toMatchObject({
      ok: false,
      reason: 'EVIDENCE_MISSING',
    })
    expect(isDone(doneEvidence({ evidence: evidenceRefs(['scope', 'review']) }))).toMatchObject({
      ok: false,
      reason: 'EVIDENCE_MISSING',
    })
    expect(isDone(doneEvidence({ evidence: evidenceRefs(['scope', 'gate']) }))).toMatchObject({
      ok: false,
      reason: 'EVIDENCE_MISSING',
    })
  })

  it('declara os tipos de evidencia exigidos por combinacao', () => {
    expect(requiredEvidenceKinds(doneEvidence())).toEqual(['scope', 'gate', 'review'])
    expect(
      requiredEvidenceKinds(
        doneEvidence({ gate: { required: false }, review: { required: false } }),
      ),
    ).toEqual(['scope'])
  })
})
