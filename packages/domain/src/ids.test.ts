import { describe, expect, it } from 'vitest'
import { InvalidIdError } from './errors.js'
import {
  agentProfileId,
  attemptId,
  gateId,
  isMissionId,
  isTaskId,
  missionId,
  parseTaskRunId,
  phaseId,
  providerId,
  runId,
  taskId,
  taskRunId,
} from './ids.js'

describe('construtores de id', () => {
  it.each(['DA-CORE-001', 'DA-BPM-021', 'X-999', 'AB1-C2-1234'])('aceita MissionId %s', (raw) => {
    expect(missionId(raw)).toBe(raw)
  })

  it.each([
    'da-core-001',
    'DA-CORE-01',
    'DACORE001',
    '',
    ' DA-CORE-001',
    'DA-CORE-001 ',
    '-DA-001',
  ])('rejeita MissionId %s', (raw) => {
    expect(() => missionId(raw)).toThrow(InvalidIdError)
  })

  it.each(['T01', 'T02', 'A123'])('aceita TaskId %s', (raw) => {
    expect(taskId(raw)).toBe(raw)
  })

  it.each(['T1', 't01', 'TT01', '01', '', 'T01 '])('rejeita TaskId %s', (raw) => {
    expect(() => taskId(raw)).toThrow(InvalidIdError)
  })

  it('rejeita RunId que nao e ULID', () => {
    expect(() => runId('nao-e-ulid')).toThrow(InvalidIdError)
    expect(runId('01J0000000000000000000000A')).toBe('01J0000000000000000000000A')
  })

  it('rejeita PhaseId, ProviderId, AgentProfileId e GateId vazios ou com espaco', () => {
    for (const factory of [phaseId, providerId, agentProfileId, gateId, attemptId]) {
      expect(() => factory('')).toThrow(InvalidIdError)
      expect(() => factory('com espaco')).toThrow(InvalidIdError)
    }
  })

  it('expoe o padrao violado no erro', () => {
    try {
      missionId('nope')
      expect.unreachable('deveria lancar')
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidIdError)
      expect((error as InvalidIdError).kind).toBe('MissionId')
      expect((error as InvalidIdError).code).toBe('INVALID_ID')
    }
  })

  it('guards nao lancam e classificam corretamente', () => {
    expect(isMissionId('DA-CORE-001')).toBe(true)
    expect(isMissionId('nope')).toBe(false)
    expect(isTaskId('T02')).toBe(true)
    expect(isTaskId(42)).toBe(false)
  })

  it('TaskRunId compoe e decompoe run + task', () => {
    const composed = taskRunId(runId('01J0000000000000000000000A'), taskId('T02'))
    expect(composed).toBe('01J0000000000000000000000A:T02')
    expect(parseTaskRunId(composed)).toEqual({
      run: '01J0000000000000000000000A',
      task: 'T02',
    })
    expect(() => parseTaskRunId('sem-separador')).toThrow(InvalidIdError)
  })
})
