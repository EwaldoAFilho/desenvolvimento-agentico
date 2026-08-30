import { RunSnapshotSchema } from '@agentic/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { GATE_ALWAYS_PASS } from '../engine/__fixtures__/files.js'
import { createHarness, DEFAULT_ACTOR, type Harness } from '../engine/__fixtures__/harness.js'
import { loadCompileReport } from './run-lifecycle.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

const BASE = {
  requireReview: false,
  defaultGate: 'unit',
  tasks: [{ id: 'T01' }],
}

const gates = { unit: [GATE_ALWAYS_PASS] }

async function draft(): Promise<Harness> {
  return createHarness({ mission: BASE, gates, approve: false, start: false })
}

describe('ciclo de vida do run', () => {
  it('cria o run em DRAFT: nao existe aprovacao automatica', async () => {
    harness = await draft()
    const run = await harness.run()
    expect(run.status).toBe('DRAFT')
    expect(run.approvedAt).toBeUndefined()
    const types = await harness.eventTypes()
    expect(types).toContain('run.created')
    expect(types).not.toContain('human.mission_approved')
  }, 120_000)

  it('congela o grafo compilado no run', async () => {
    harness = await draft()
    const run = await harness.run()
    expect(run.specHash).toBe(harness.compiled.specHash)
    expect(run.graph.tasks.map((task) => task.id)).toEqual(['T01'])
    expect(run.policies.workspaceMode).toBe('git-worktree')
    expect(run.integrationBranch).toBe('mission/DA-TEST-001')
  }, 120_000)

  it('recusa START MISSION sem aprovacao humana', async () => {
    harness = await draft()
    await expect(
      harness.plane.startRun({
        runId: harness.runId,
        actor: DEFAULT_ACTOR,
        acceptWarnings: true,
      }),
    ).rejects.toThrow(/APPROVED/)
  }, 120_000)

  it('registra a aprovacao humana com autor', async () => {
    harness = await draft()
    await harness.plane.approveMission({ runId: harness.runId, actor: 'ana@time' })
    const run = await harness.run()
    expect(run.status).toBe('APPROVED')
    expect(run.approvedAt).toBeInstanceOf(Date)
    const events = await harness.events()
    const approval = events.find((event) => event.type === 'human.mission_approved')
    expect(approval?.type === 'human.mission_approved' ? approval.payload.actor : '').toBe(
      'ana@time',
    )
    expect(approval?.actor.kind).toBe('human')
  }, 120_000)

  it('recusa aprovacao sem autor', async () => {
    harness = await draft()
    await expect(
      harness.plane.approveMission({ runId: harness.runId, actor: '   ' }),
    ).rejects.toThrow(/autor/)
  }, 120_000)

  it('recusa partida com diagnostico ERROR', async () => {
    harness = await draft()
    await harness.plane.approveMission({ runId: harness.runId, actor: DEFAULT_ACTOR })
    await expect(
      harness.plane.startRun({
        runId: harness.runId,
        actor: DEFAULT_ACTOR,
        acceptWarnings: true,
        diagnostics: [
          { code: 'DA1005', severity: 'ERROR', message: 'ciclo detectado', targets: ['T01'] },
        ],
      }),
    ).rejects.toThrow(/ERROR/)
    expect((await harness.run()).status).toBe('APPROVED')
  }, 120_000)

  it('exige aceite explicito quando ha WARNING', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: null,
        tasks: [{ id: 'T01', gate: null, validation: [] }],
      },
      gates,
      approve: false,
      start: false,
    })
    const report = await loadCompileReport(harness.plane.deps, harness.runId)
    expect(report?.stats.warnings).toBeGreaterThan(0)

    await harness.plane.approveMission({ runId: harness.runId, actor: DEFAULT_ACTOR })
    await expect(
      harness.plane.startRun({
        runId: harness.runId,
        actor: DEFAULT_ACTOR,
        acceptWarnings: false,
      }),
    ).rejects.toThrow(/aceite explicito/)

    const started = await harness.plane.startRun({
      runId: harness.runId,
      actor: DEFAULT_ACTOR,
      acceptWarnings: true,
    })
    expect(started.status).toBe('RUNNING')
    const events = await harness.events()
    const start = events.find((event) => event.type === 'run.started')
    expect(start?.type === 'run.started' ? start.payload.warningsAccepted : false).toBe(true)
  }, 120_000)

  it('inicia o run e marca o instante de partida', async () => {
    harness = await draft()
    await harness.plane.approveMission({ runId: harness.runId, actor: DEFAULT_ACTOR })
    const started = await harness.plane.startRun({
      runId: harness.runId,
      actor: DEFAULT_ACTOR,
      acceptWarnings: true,
    })
    expect(started.status).toBe('RUNNING')
    expect(started.startedAt).toBeInstanceOf(Date)
  }, 120_000)

  it('devolve snapshot valido antes de qualquer despacho', async () => {
    harness = await draft()
    const snapshot = await harness.plane.getRunSnapshot(harness.runId)
    expect(RunSnapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(snapshot.run.status).toBe('DRAFT')
    expect(snapshot.counters.PENDING).toBe(1)
    expect(snapshot.metrics.attempts).toBe(0)
    expect(snapshot.providers.length).toBeGreaterThan(0)
  }, 120_000)
})
