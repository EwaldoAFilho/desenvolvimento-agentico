import { describe, expect, it } from 'vitest'
import type { CompileReportDto, RunHeaderDto } from './contracts.js'
import { missionFilesOnDisk, missionIdOfFile, stateOfRun, summarizeMissions } from './missions.js'

const run = (missionId: string, status: RunHeaderDto['status']): RunHeaderDto =>
  ({
    id: '01J0000000000000000000000A',
    missionId,
    status,
    timestamps: { createdAt: '2026-01-01T00:00:00.000Z' },
    policies: {},
  }) as unknown as RunHeaderDto

const report = (missionId: string, ok: boolean): CompileReportDto =>
  ({
    missionId,
    ok,
    diagnostics: [],
    stats: { tasks: 3, phases: 1 },
  }) as unknown as CompileReportDto

describe('missions', () => {
  it('id sai do nome do arquivo quando nao ha relatorio', () => {
    expect(missionIdOfFile('.agentic/missions/DA-CORE-001.mission.yaml')).toBe('DA-CORE-001')
    expect(missionIdOfFile('x/y.yml')).toBe('y')
  })

  it('lista do disco usa o mesmo filtro e o mesmo caminho relativo do servidor', () => {
    expect(
      missionFilesOnDisk('/repo/.agentic/missions', '/repo', [
        'b.yaml',
        'nota.md',
        'a.mission.yml',
      ]),
    ).toEqual([
      { file: '.agentic/missions/a.mission.yml', path: '/repo/.agentic/missions/a.mission.yml' },
      { file: '.agentic/missions/b.yaml', path: '/repo/.agentic/missions/b.yaml' },
    ])
  })

  it('estado: ultimo run manda; sem run, o compile decide; sem nada, UNKNOWN', () => {
    expect(stateOfRun('RUNNING', true)).toBe('RUNNING')
    expect(stateOfRun(undefined, true)).toBe('READY')
    expect(stateOfRun(undefined, false)).toBe('INVALID')
    expect(stateOfRun(undefined, undefined)).toBe('UNKNOWN')
  })

  it('resumo junta arquivo, relatorio e ultimo run; runs desconhecidos ficam marcados', () => {
    const files = [
      { file: '.agentic/missions/A.mission.yaml', path: '/repo/.agentic/missions/A.mission.yaml' },
      { file: '.agentic/missions/B.mission.yaml', path: '/repo/.agentic/missions/B.mission.yaml' },
    ]
    const reports = new Map([[files[0]?.file ?? '', report('A', true)]])
    const online = summarizeMissions(files, [run('A', 'COMPLETED')], reports)
    expect(online[0]).toMatchObject({ id: 'A', state: 'COMPLETED', runsKnown: true, ok: true })
    expect(online[0]?.lastRun?.status).toBe('COMPLETED')
    expect(online[1]).toMatchObject({ id: 'B', state: 'UNKNOWN', runsKnown: true })
    const offline = summarizeMissions(files, undefined, new Map())
    expect(offline.every((m) => m.runsKnown === false && m.state === 'UNKNOWN')).toBe(true)
  })
})
