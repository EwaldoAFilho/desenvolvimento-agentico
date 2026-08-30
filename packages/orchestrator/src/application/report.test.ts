import type { MissionId, RunId, TaskId } from '@agentic/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { pass, review, type StepFn } from '../engine/__fixtures__/agents.js'
import {
  GATE_ALWAYS_FAIL,
  GATE_ALWAYS_PASS,
  GATE_FIRST_ATTEMPT_FAILS,
} from '../engine/__fixtures__/files.js'
import { createHarness, type Harness } from '../engine/__fixtures__/harness.js'
import { type MissionReport, renderMissionReport } from './report.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

const step: StepFn = (context) =>
  context.kind === 'review'
    ? review('PASS')
    : pass(`${context.taskId} tentativa ${context.attemptNumber}`, {
        [`packages/${context.taskId.toLowerCase()}/${context.taskId}.ts`]: `export const x = ${context.attemptNumber}\n`,
      })

const REPORT: MissionReport = {
  runId: '01J0000000000000000000000A' as RunId,
  missionId: 'DA-TEST-001' as MissionId,
  status: 'COMPLETED',
  tasks: { total: 3, done: 2, skipped: 1, cancelled: 0, blocked: 0 },
  attempts: 4,
  retries: 1,
  reviewFailures: 1,
  missionGate: { gateId: 'mission', status: 'PASS' },
  wallTimeMs: 12_500,
  criticalPath: { tasks: ['T01' as TaskId, 'T02' as TaskId], durationMs: 9_000 },
  slowestTasks: [{ taskId: 'T02' as TaskId, title: 'motor', durationMs: 7_000 }],
  retriedTasks: [{ taskId: 'T02' as TaskId, attempts: 2, failures: ['GATE_FAILED'] }],
  blockages: [
    {
      taskId: 'T03' as TaskId,
      kind: 'ATTEMPTS_EXHAUSTED',
      reason: 'GATE_FAILED: gate unit terminou FAIL',
      needs: 'decisao humana',
    },
  ],
  evidence: [
    {
      scope: 'task',
      taskId: 'T02' as TaskId,
      gateId: 'unit',
      status: 'PASS',
      command: 'npm test',
      cwd: '/tmp/w/T02-a2',
      exitCode: 0,
      line: 'cd /tmp/w/T02-a2 && npm test',
    },
  ],
}

describe('renderMissionReport', () => {
  it('abre com o resultado da missao', () => {
    const text = renderMissionReport(REPORT)
    expect(text).toContain('# Relatorio da missao DA-TEST-001')
    expect(text).toContain('resultado: **COMPLETED**')
    expect(text).toContain('tasks concluidas: 2/3')
  })

  it('mostra tentativas, retries e reprovacoes de review', () => {
    const text = renderMissionReport(REPORT)
    expect(text).toContain('tentativas: 4 · retries: 1 · reprovacoes de review: 1')
    expect(text).toContain('mission gate: mission PASS')
    expect(text).toContain('wall time: 12.5s')
  })

  it('lista caminho critico real, tasks demoradas e retries', () => {
    const text = renderMissionReport(REPORT)
    expect(text).toContain('T01 -> T02 (9.0s)')
    expect(text).toContain('T02 motor: 7.0s')
    expect(text).toContain('T02: 2 tentativas (GATE_FAILED)')
  })

  it('cita evidencia reproduzivel e bloqueios', () => {
    const text = renderMissionReport(REPORT)
    expect(text).toContain('cd /tmp/w/T02-a2 && npm test')
    expect(text).toContain('T03 [ATTEMPTS_EXHAUSTED]')
  })
})

describe('GenerateMissionReport sobre um run real', () => {
  it('mede retries, bloqueios e evidencia citavel', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        maxAttempts: 2,
        tasks: [
          { id: 'T01', gate: 'flaky' },
          { id: 'T02', gate: 'broken' },
        ],
      },
      gates: {
        unit: [GATE_ALWAYS_PASS],
        flaky: [GATE_FIRST_ATTEMPT_FAILS],
        broken: [GATE_ALWAYS_FAIL],
      },
      step,
    })
    await harness.orchestrator.drain()

    const report = await harness.plane.generateMissionReport(harness.runId)
    expect(report.tasks.done).toBe(1)
    expect(report.tasks.blocked).toBe(1)
    expect(report.attempts).toBe(4)
    expect(report.retries).toBe(2)
    expect(report.retriedTasks.map((task) => task.taskId)).toEqual(['T01', 'T02'])
    expect(report.blockages[0]?.taskId).toBe('T02')
    expect(report.evidence.length).toBeGreaterThanOrEqual(4)
    expect(report.evidence.every((item) => item.scope === 'task')).toBe(true)
    expect(report.criticalPath.tasks.length).toBeGreaterThan(0)

    const markdown = renderMissionReport(report)
    expect(markdown).toContain('T02 [ATTEMPTS_EXHAUSTED]')
    expect(markdown).toContain('exit')
  }, 120_000)

  it('cita o gate da missao quando ele rodou', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        missionGate: 'mission',
        tasks: [{ id: 'T01' }],
      },
      gates: { unit: [GATE_ALWAYS_PASS], mission: [GATE_ALWAYS_PASS] },
      step,
    })
    await harness.orchestrator.drain()

    const report = await harness.plane.generateMissionReport(harness.runId)
    expect(report.status).toBe('COMPLETED')
    expect(report.missionGate).toEqual({ gateId: 'mission', status: 'PASS' })
    expect(report.evidence.some((item) => item.scope === 'mission')).toBe(true)
    expect(report.wallTimeMs).toBeGreaterThanOrEqual(0)
  }, 120_000)
})
