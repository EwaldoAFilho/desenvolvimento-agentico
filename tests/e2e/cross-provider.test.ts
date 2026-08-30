import { compileMission } from '@agentic/compiler'
import { afterEach, describe, expect, it } from 'vitest'
import { withoutProvider } from './support/fixture.js'
import { createMissionHarness, type MissionHarness } from './support/harness.js'

/**
 * `cross-provider-required` (I10 / ADR-0011). A T05 do fixture declara risco alto e a
 * politica cruzada. Com dois fornecedores ela e revisada por outro; com um so, BLOQUEIA —
 * nunca e rebaixada em silencio para caber no ambiente.
 */

let harness: MissionHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

describe('com dois fornecedores registrados', () => {
  it('revisa a task de risco alto com fornecedor diferente do executor', async () => {
    harness = await createMissionHarness({ safetyIntervalMs: 0 })
    expect(harness.plane.registry.list()).toEqual(['claude-code', 'codex'])

    await harness.start()
    await harness.drain()

    const task = await harness.task('T05')
    expect(task.status).toBe('DONE')

    const attempt = (await harness.attempts('T05'))[0]
    expect(attempt?.review?.policy).toBe('cross-provider-required')
    expect(attempt?.review?.policyOutcome).toBe('satisfied')
    expect(attempt?.review?.reviewer.providerId).not.toBe(attempt?.executor.providerId)
    expect(attempt?.review?.reviewer.sessionRef).not.toBe(attempt?.executor.sessionRef)

    const tipos = await harness.eventTypes()
    expect(tipos).not.toContain('review.policy_downgraded')
    expect((await harness.run()).status).toBe('COMPLETED')
  }, 120_000)
})

describe('removendo o segundo fornecedor', () => {
  it('avisa na compilacao e bloqueia a task em vez de rebaixar a politica', async () => {
    const project = (text: string): string => withoutProvider(text, 'codex')
    harness = await createMissionHarness({ project, safetyIntervalMs: 0 })
    expect(harness.plane.registry.list()).toEqual(['claude-code'])

    // O compilador avisa ANTES de qualquer execucao: DA2008.
    const compiled = compileMission({
      missionText: harness.sources.missionText,
      projectFile: harness.sources.projectText,
      gatesFile: harness.sources.gatesText,
    })
    const codigos = compiled.diagnostics.map((item) => item.code)
    expect(codigos).toEqual(['DA2008'])
    expect(compiled.diagnostics[0]?.severity).toBe('WARNING')
    expect(compiled.diagnostics[0]?.targets).toContain('T05')

    // Com WARNING pendente a partida exige aceite explicito.
    await expect(harness.start({ acceptWarnings: false })).rejects.toThrow(/WARNING/)
    await harness.start({ acceptWarnings: true })
    await harness.drain()

    const task = await harness.task('T05')
    expect(task.status).toBe('BLOCKED')
    expect(task.blockage?.kind).toBe('POLICY')
    expect(task.blockage?.reason).toBe('CROSS_PROVIDER_UNAVAILABLE')

    const attempt = (await harness.attempts('T05'))[0]
    expect(attempt?.review).toBeUndefined()

    const tipos = await harness.eventTypes()
    expect(tipos).not.toContain('review.policy_downgraded')
    expect(tipos).toContain('task.blocked')
    expect((await harness.run()).status).toBe('BLOCKED')

    // As tasks de politica `fresh-session` seguem concluindo com um fornecedor so: o que
    // bloqueia e a exigencia cruzada, nao a falta de fornecedor em geral.
    const t01 = await harness.task('T01')
    expect(t01.status).toBe('DONE')
    const revisao = (await harness.attempts('T01'))[0]?.review
    expect(revisao?.policy).toBe('fresh-session')
    expect(revisao?.policyOutcome).toBe('satisfied')
  }, 120_000)
})
