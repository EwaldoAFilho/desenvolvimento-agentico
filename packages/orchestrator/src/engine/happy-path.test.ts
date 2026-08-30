import { taskId as toTaskId } from '@agentic/domain'
import { RunSnapshotSchema, TaskDetailSchema } from '@agentic/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GATE_ALWAYS_PASS, GATE_PRINT_BRANCH } from './__fixtures__/files.js'
import { createHarness, type Harness } from './__fixtures__/harness.js'

let harness: Harness

const MISSION = {
  requireReview: true,
  defaultGate: 'unit',
  missionGate: 'mission',
  tasks: [
    { id: 'T01' },
    { id: 'T02' },
    { id: 'T03', dependencies: ['T01'] },
    { id: 'T04', dependencies: ['T02'] },
    { id: 'T05', dependencies: ['T03', 'T04'] },
  ],
}

beforeAll(async () => {
  harness = await createHarness({
    mission: MISSION,
    gates: { unit: [GATE_ALWAYS_PASS], mission: [GATE_PRINT_BRANCH] },
  })
  await harness.orchestrator.drain()
}, 180_000)

afterAll(async () => {
  await harness?.cleanup()
})

describe('caminho feliz completo', () => {
  it('nao acumula erro de trabalho assincrono', () => {
    expect(harness.orchestrator.errors).toEqual([])
  })

  it('leva todas as tasks a DONE', async () => {
    const tasks = await harness.tasks()
    expect(tasks.map((task) => task.status)).toEqual(['DONE', 'DONE', 'DONE', 'DONE', 'DONE'])
  })

  it('conclui o run com COMPLETED', async () => {
    const run = await harness.run()
    expect(run.status).toBe('COMPLETED')
    expect(run.finishedAt).toBeInstanceOf(Date)
  })

  it('registra o mission gate no run', async () => {
    const run = await harness.run()
    expect(run.missionGateId).toBe('mission')
    expect(run.missionGateExecutionId).toBeTypeOf('string')
  })

  it('usa uma tentativa por task', async () => {
    const tasks = await harness.tasks()
    expect(tasks.every((task) => task.attemptCount === 1)).toBe(true)
    expect((await harness.attempts()).length).toBe(5)
  })

  it('fecha cada tentativa com PASS, commit e observacao medida', async () => {
    const attempts = await harness.attempts()
    for (const attempt of attempts) {
      expect(attempt.result).toBe('PASS')
      expect(attempt.observation?.scopeCheck).toBe('PASS')
      expect(attempt.observation?.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(attempt.observation?.diffStat.files).toBeGreaterThan(0)
      expect(attempt.finishedAt).toBeInstanceOf(Date)
    }
  })

  it('registra o processo de agente que executou a tentativa (I11)', async () => {
    const attempts = await harness.attempts('T03')
    const runtime = attempts[0]?.executor.runtime
    expect(runtime?.handle).toBeTypeOf('string')
    expect(runtime?.cwd).toBe(attempts[0]?.workspace.path)
    expect(runtime?.cwd).toContain('T03-a1')
  })

  it('persiste os claims do agente sem deixar que decidam', async () => {
    const attempts = await harness.attempts('T01')
    expect(attempts[0]?.claims?.summary).toContain('T01')
  })

  it('emite os eventos do ciclo na ordem esperada para uma task', async () => {
    const events = await harness.events()
    const t01 = events.filter((event) => event.taskId === 'T01').map((event) => event.type)
    expect(t01).toEqual([
      'task.created',
      'task.ready',
      'workspace.acquired',
      'attempt.started',
      'task.dispatched',
      'attempt.observed',
      'task.verifying',
      'gate.started',
      'gate.command_finished',
      'gate.finished',
      'task.review_requested',
      'review.requested',
      'review.finished',
      'task.integrating',
      'workspace.integrated',
      'attempt.finished',
      'task.done',
      'workspace.released',
    ])
  })

  it('emite os eventos de run na ordem esperada', async () => {
    const types = await harness.eventTypes()
    const runEvents = types.filter((type) => type.startsWith('run.'))
    expect(runEvents).toEqual([
      'run.created',
      'run.approved',
      'run.started',
      'run.verifying',
      'run.completed',
    ])
  })

  it('so libera dependente depois da dependencia concluida', async () => {
    const events = await harness.events()
    const doneT01 = events.find((event) => event.type === 'task.done' && event.taskId === 'T01')
    const readyT03 = events.find((event) => event.type === 'task.ready' && event.taskId === 'T03')
    expect(doneT01?.seq).toBeLessThan(readyT03?.seq ?? 0)
  })

  it('registra evidencia de escopo, gate e revisao em cada DONE', async () => {
    const events = await harness.events()
    const done = events.filter((event) => event.type === 'task.done')
    expect(done).toHaveLength(5)
    for (const event of done) {
      const kinds = event.type === 'task.done' ? event.payload.evidence.map((ref) => ref.kind) : []
      expect(kinds).toContain('scope')
      expect(kinds).toContain('gate')
      expect(kinds).toContain('review')
      expect(kinds).toContain('integration')
    }
  })

  it('roda o task gate na worktree da tentativa', async () => {
    const attempts = await harness.attempts('T02')
    const execution = attempts[0]?.gateExecutions[0]
    expect(execution?.status).toBe('PASS')
    expect(execution?.results[0]?.cwd).toContain('T02-a1')
  })

  it('integra cada task na branch da missao', async () => {
    const branches = await harness.git('branch', '--list', 'mission/DA-TEST-001')
    expect(branches).toContain('mission/DA-TEST-001')
    const log = await harness.git('log', '--oneline', 'mission/DA-TEST-001')
    expect(log.split('\n').length).toBeGreaterThanOrEqual(6)
  })

  it('roda o mission gate na branch da missao, nao na ultima tentativa', async () => {
    const events = await harness.events()
    const finished = events.filter(
      (event) => event.type === 'gate.finished' && event.taskId === undefined,
    )
    expect(finished).toHaveLength(1)
    const raw = await harness.plane.persistence.artifacts.readText(
      harness.runId,
      'mission/gate.json',
    )
    const execution = JSON.parse(raw) as {
      status: string
      results: { cwd: string; stdoutRef?: string }[]
    }
    expect(execution.status).toBe('PASS')
    const cwd = execution.results[0]?.cwd ?? ''
    expect(cwd).toMatch(/\/mission$/)
    expect(cwd).not.toContain('-a1')
    const stdout = await harness.plane.persistence.artifacts.readText(
      harness.runId,
      execution.results[0]?.stdoutRef ?? '',
    )
    expect(stdout.trim()).toBe('mission/DA-TEST-001')
  })

  it('descarta a worktree da tentativa concluida', async () => {
    const worktrees = await harness.git('worktree', 'list')
    expect(worktrees).not.toContain('T01-a1')
  })

  it('produz um snapshot valido no contrato publico', async () => {
    const snapshot = await harness.plane.getRunSnapshot(harness.runId)
    expect(RunSnapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(snapshot.counters.DONE).toBe(5)
    expect(snapshot.metrics.attempts).toBe(5)
    expect(snapshot.graph.criticalPath.length).toBeGreaterThan(0)
  })

  it('produz um detalhe de task valido no contrato publico', async () => {
    const detail = await harness.plane.getTaskDetail(harness.runId, toTaskId('T05'))
    const parsed = TaskDetailSchema.safeParse(detail)
    expect(parsed.success).toBe(true)
    expect(detail.status).toBe('DONE')
    expect(detail.graph.dependencies.map((dependency) => dependency.status)).toEqual([
      'DONE',
      'DONE',
    ])
    expect(detail.quality.gateStatus).toBe('PASS')
    expect(detail.review.verdict).toBe('PASS')
    expect(detail.isolation.worktreePath).toContain('T05-a1')
  })

  it('gera relatorio final com caminho critico real e evidencia citavel', async () => {
    const report = await harness.plane.generateMissionReport(harness.runId)
    expect(report.status).toBe('COMPLETED')
    expect(report.tasks.done).toBe(5)
    expect(report.attempts).toBe(5)
    expect(report.retries).toBe(0)
    expect(report.missionGate?.status).toBe('PASS')
    expect(report.criticalPath.tasks.length).toBeGreaterThanOrEqual(3)
    expect(report.criticalPath.durationMs).toBeGreaterThan(0)
    expect(report.evidence.some((item) => item.scope === 'mission')).toBe(true)
    expect(report.evidence.every((item) => item.line.startsWith('cd '))).toBe(true)
  })
})
