import type { GateExecution, Observation, Review } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import {
  digestOf,
  gateEvidence,
  integrationEvidence,
  reviewEvidence,
  scopeEvidence,
} from './evidence.js'

const observation: Observation = {
  filesChanged: [{ path: 'packages/a/a.ts', change: 'M', added: 2, removed: 1 }],
  diffStat: { files: 1, added: 2, removed: 1 },
  outOfScopePaths: [],
  scopeCheck: 'PASS',
  commit: 'abc',
}

const gate: GateExecution = {
  id: 'gate_1',
  gateId: 'unit' as GateExecution['gateId'],
  scope: 'task',
  runId: '01J0000000000000000000000A' as GateExecution['runId'],
  startedAt: new Date(0),
  status: 'PASS',
  results: [],
}

describe('evidencia citavel', () => {
  it('produz digest estavel para o mesmo conteudo', () => {
    expect(digestOf({ a: 1 })).toBe(digestOf({ a: 1 }))
  })

  it('muda o digest quando o conteudo muda', () => {
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }))
  })

  it('referencia o artefato de patch na evidencia de escopo', () => {
    const ref = scopeEvidence('att-1', observation, 'runs/x/patch.diff')
    expect(ref.kind).toBe('scope')
    expect(ref.sourceId).toBe('att-1')
    expect(ref.artifactPath).toBe('runs/x/patch.diff')
    expect(ref.digest).toHaveLength(64)
  })

  it('cobre gate, review e integracao', () => {
    const review = {
      id: 'rev-1',
      reviewer: { sessionRef: 's1' },
      verdict: 'PASS',
      policy: 'fresh-session',
      policyOutcome: 'satisfied',
    } as unknown as Review
    expect(gateEvidence(gate).kind).toBe('gate')
    expect(reviewEvidence(review).kind).toBe('review')
    expect(integrationEvidence('att-1', { status: 'MERGED' }).kind).toBe('integration')
  })
})
