import type { Gate, GateId } from '@agentic/domain'
import { attemptId, gateId, runId } from '@agentic/domain'
import type { GateCommandRecord, GateProfiles, GateRunResult } from '@agentic/gates'
import { describe, expect, it } from 'vitest'
import { runGate } from './gate-run.js'
import type { ArtifactWriter, GateExecutor } from './types.js'

/**
 * STABILITY-SLICE-004B, revisao ciclo 1 (C3): o residuo de um gate nao pode se perder no
 * caminho ate o orquestrador. Dois furos apontados pelo revisor:
 *
 * - o gate rodou, deixou grupo vivo (pid conhecido), e a persistencia do artefato de saida
 *   FALHOU: o `catch` devolvia so `failure` e os pids sumiam — a posse podia sair (I15);
 * - um registro com `groupTerminated=false` e `pid=null` (permitido pelo tipo) era ignorado
 *   em vez de virar residuo nao sondavel que falha fechado, como a ADR-0014 promete.
 */

const RUN = runId('01J0000000000000000000000A')
const GATE: GateId = gateId('unit')
const ATTEMPT = attemptId('T01-a1')

const gates: GateProfiles = {
  require: (): Gate => ({ id: GATE, commands: [{ run: 'node -e 0' }], env: [] }),
} as unknown as GateProfiles

function record(overrides: Partial<GateCommandRecord>): GateCommandRecord {
  return {
    index: 0,
    command: 'node -e 0',
    cwd: '/w',
    required: true,
    argv: ['node', '-e', '0'],
    exitCode: 0,
    signal: null,
    timedOut: false,
    groupTerminated: true,
    pid: 4242,
    durationMs: 5,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:00:01Z'),
    truncated: false,
    stdout: { text: 'saida', truncated: false, digest: 'd', artifactDigest: 'd' },
    stderr: { text: '', truncated: false, digest: 'e', artifactDigest: 'e' },
    ...overrides,
  }
}

function runner(records: readonly GateCommandRecord[]): GateExecutor {
  const result: GateRunResult = {
    id: 'gate_1',
    gateId: GATE,
    scope: 'task',
    runId: RUN,
    attemptId: ATTEMPT,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:00:01Z'),
    status: 'PASS',
    results: records,
    skipped: [],
    residualProcess: records.some((item) => !item.groupTerminated),
    cwd: '/w',
    envAllow: [],
  }
  return { run: () => Promise.resolve(result) }
}

const artefatoQueFalha: ArtifactWriter = {
  write: () => Promise.reject(new Error('disco cheio')),
}

const artefatoOk: ArtifactWriter = {
  write: (input) => Promise.resolve({ path: input.relativePath, digest: 'x', bytes: 1 } as never),
}

describe('runGate — o residuo sobrevive ao caminho ate o orquestrador', () => {
  it('artefato de saida que falha NAO apaga os grupos que o gate deixou vivos', async () => {
    const outcome = await runGate({
      gates,
      gateRunner: runner([record({ groupTerminated: false, pid: 4242 })]),
      artifacts: artefatoQueFalha,
      runId: RUN,
      gateId: GATE,
      scope: 'task',
      cwd: '/w',
      attemptId: ATTEMPT,
      directory: 'attempts/T01-a1',
    })
    expect(outcome.failure?.code).toBe('POLICY_VIOLATION')
    expect(outcome.residualGroups).toEqual([4242])
  })

  it('registro com grupo vivo e SEM pid vira residuo nao sondavel (falha fechado), nunca some', async () => {
    const outcome = await runGate({
      gates,
      gateRunner: runner([
        record({ index: 0, groupTerminated: true, pid: 1 }),
        record({ index: 1, groupTerminated: false, pid: null }),
      ]),
      artifacts: artefatoOk,
      runId: RUN,
      gateId: GATE,
      scope: 'task',
      cwd: '/w',
      attemptId: ATTEMPT,
      directory: 'attempts/T01-a1',
    })
    expect(outcome.execution?.status).toBe('PASS')
    expect(outcome.residualGroups).toEqual([null])
  })

  it('grupo assentado em todo comando: nenhum residuo', async () => {
    const outcome = await runGate({
      gates,
      gateRunner: runner([record({})]),
      artifacts: artefatoOk,
      runId: RUN,
      gateId: GATE,
      scope: 'task',
      cwd: '/w',
      attemptId: ATTEMPT,
      directory: 'attempts/T01-a1',
    })
    expect(outcome.residualGroups).toBeUndefined()
  })
})
