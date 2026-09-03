import { describe, expect, it } from 'vitest'
import type { MissionSummaryDto } from './contracts.js'
import { missionFilesOnDisk, missionIdOfFile, summariesFromControlPlane } from './missions.js'

const dto = (partial: Partial<MissionSummaryDto>): MissionSummaryDto =>
  ({
    file: '.agentic/missions/A.mission.yaml',
    title: 'A',
    state: 'PLANNED',
    tasks: 3,
    phases: 1,
    errors: 0,
    warnings: 0,
    ...partial,
  }) as MissionSummaryDto

describe('missions', () => {
  it('id sai do nome do arquivo quando o servidor nao o declara', () => {
    expect(missionIdOfFile('.agentic/missions/DA-CORE-001.mission.yaml')).toBe('DA-CORE-001')
    expect(missionIdOfFile('x/y.yml')).toBe('y')
    expect(summariesFromControlPlane('/repo', [dto({})])[0]?.id).toBe('A')
    expect(summariesFromControlPlane('/repo', [dto({ id: 'X' })])[0]?.id).toBe('X')
  })

  it('prefixo textual nao e contencao: /srv/repo-config nao esta dentro de /srv/repo', () => {
    const [item] = missionFilesOnDisk('/srv/repo-config/.agentic/missions', '/srv/repo', ['a.yaml'])
    expect(item?.file).toBe('/srv/repo-config/.agentic/missions/a.yaml')
  })

  it('lista do disco usa o mesmo filtro do servidor e nao inventa estado', () => {
    const items = missionFilesOnDisk('/repo/.agentic/missions', '/repo', [
      'b.yaml',
      'nota.md',
      'a.mission.yml',
    ])
    expect(items.map((m) => [m.file, m.state, m.runsKnown])).toEqual([
      ['.agentic/missions/a.mission.yml', 'UNKNOWN', false],
      ['.agentic/missions/b.yaml', 'UNKNOWN', false],
    ])
  })

  it('listagem do control plane carrega estado, contadores, ultimo run e caminho absoluto', () => {
    const [item] = summariesFromControlPlane('/repo', [
      dto({
        id: 'A',
        state: 'RUNNING',
        lastRun: {
          id: '01J0',
          missionId: 'A',
          status: 'RUNNING',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    ])
    expect(item).toMatchObject({
      id: 'A',
      state: 'RUNNING',
      tasks: 3,
      runsKnown: true,
      path: '/repo/.agentic/missions/A.mission.yaml',
    })
    expect(item?.lastRun?.id).toBe('01J0')
  })
})
