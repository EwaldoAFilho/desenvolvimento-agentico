import { taskId as toTaskId } from '@agentic/domain'
import { parseProjectFile, TaskDetailSchema } from '@agentic/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { GATE_ALWAYS_PASS, projectYaml } from './__fixtures__/files.js'
import { createHarness, type Harness } from './__fixtures__/harness.js'
import { profilesOf } from './control-plane.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

function projectOf(text: string) {
  const parsed = parseProjectFile(text)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return parsed.value
}

describe('composition root', () => {
  it('sintetiza um perfil por papel quando o projeto nao declara nenhum', () => {
    const project = projectOf(projectYaml({ providers: [{ id: 'mock', maxConcurrent: 2 }] }))
    const profiles = profilesOf(project)
    expect(profiles.map((profile) => profile.id)).toEqual(['mock.executor', 'mock.reviewer'])
    expect(profiles.every((profile) => profile.providerId === 'mock')).toBe(true)
  })

  it('cobre todos os providers declarados no registry', () => {
    const project = projectOf(
      projectYaml({
        providers: [
          { id: 'mock', maxConcurrent: 2 },
          { id: 'mock-alt', maxConcurrent: 1 },
        ],
      }),
    )
    const providers = new Set(profilesOf(project).map((profile) => profile.providerId))
    expect([...providers].sort()).toEqual(['mock', 'mock-alt'])
  })

  it('devolve detalhe de task valido antes de qualquer tentativa', async () => {
    harness = await createHarness({
      mission: {
        requireReview: false,
        defaultGate: 'unit',
        tasks: [{ id: 'T01' }, { id: 'T02', dependencies: ['T01'] }],
      },
      gates: { unit: [GATE_ALWAYS_PASS] },
      start: false,
      approve: false,
    })
    const detail = await harness.plane.getTaskDetail(harness.runId, toTaskId('T02'))
    expect(TaskDetailSchema.safeParse(detail).success).toBe(true)
    expect(detail.status).toBe('PENDING')
    expect(detail.attempts).toEqual([])
    expect(detail.facts.diffStat).toEqual({ files: 0, added: 0, removed: 0 })
    expect(detail.graph.dependencies).toEqual([{ id: 'T01', status: 'PENDING' }])
    expect(detail.quality.gate).toBe('unit')
    expect(detail.events.map((event) => event.type)).toEqual(['task.created'])
  }, 120_000)

  it('reabre o mesmo run em um control plane novo', async () => {
    harness = await createHarness({
      mission: { requireReview: false, defaultGate: 'unit', tasks: [{ id: 'T01' }] },
      gates: { unit: [GATE_ALWAYS_PASS] },
    })
    await harness.orchestrator.drain()
    const reopened = await harness.reopen()
    harness = reopened
    const snapshot = await reopened.plane.getRunSnapshot(reopened.runId)
    expect(snapshot.run.status).toBe('COMPLETED')
    expect(snapshot.counters.DONE).toBe(1)
  }, 120_000)
})
