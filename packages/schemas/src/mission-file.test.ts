import { describe, expect, it } from 'vitest'
import { MINIMAL_MISSION_YAML, MISSION_WITH_DEFAULTS_YAML } from './__fixtures__/samples.js'
import { issueAt, issuesOf, type SchemaIssue } from './issues.js'
import { MAX_TASKS_PER_MISSION } from './mission-file.js'
import { parseMissionFile } from './parse.js'

function onlyIssue(text: string): SchemaIssue {
  const issues = issuesOf(parseMissionFile(text))
  expect(issues).toHaveLength(1)
  const issue = issues[0]
  if (issue === undefined) throw new Error('esperava exatamente uma issue')
  return issue
}

describe('MissionFileSchema — valido', () => {
  it('aceita a missao minima', () => {
    const result = parseMissionFile(MINIMAL_MISSION_YAML)
    expect(issuesOf(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('aplica default de dependencies, risk e estimate', () => {
    const result = parseMissionFile(MINIMAL_MISSION_YAML)
    if (!result.ok) throw new Error('deveria parsear')
    const task = result.value.tasks[0]
    expect(task?.dependencies).toEqual([])
    expect(task?.risk).toBe('medium')
    expect(task?.estimate).toBe(1)
  })

  it('aceita as tres politicas de revisao', () => {
    for (const policy of ['fresh-session', 'cross-provider-preferred', 'cross-provider-required']) {
      const text = MINIMAL_MISSION_YAML.replace(
        '    objective: Fazer a coisa certa\n',
        `    objective: Fazer a coisa certa\n    reviewPolicy: ${policy}\n`,
      )
      const result = parseMissionFile(text)
      expect(issuesOf(result)).toEqual([])
    }
  })

  it('aceita uma linha de texto livre que o YAML leu como mapa de uma chave', () => {
    const text = MINIMAL_MISSION_YAML.replace(
      '  - Criterio um\n',
      '  - Sem API key: agente roda por CLI local\n',
    )
    const result = parseMissionFile(text)
    if (!result.ok) throw new Error('deveria parsear')
    expect(result.value.acceptanceCriteria).toEqual(['Sem API key: agente roda por CLI local'])
  })
})

describe('MissionFileSchema — invalido com localizacao', () => {
  it('recusa apiVersion desconhecida apontando linha e coluna', () => {
    const issue = onlyIssue(MINIMAL_MISSION_YAML.replace('agentic/v1', 'agentic/v2'))
    expect(issue.path).toBe('apiVersion')
    expect(issue.line).toBe(1)
    expect(issue.column).toBe(13)
  })

  it('recusa kind diferente de Mission', () => {
    const issue = onlyIssue(MINIMAL_MISSION_YAML.replace('kind: Mission', 'kind: Project'))
    expect(issue.path).toBe('kind')
    expect(issue.line).toBe(2)
  })

  it('recusa id fora do regex apontando a linha do id', () => {
    const issue = onlyIssue(MINIMAL_MISSION_YAML.replace('DA-TEST-001', 'da-test-1'))
    expect(issue.path).toBe('id')
    expect(issue.line).toBe(3)
    expect(issue.column).toBe(5)
    expect(issue.message).toContain('MissionId')
  })

  it('recusa task sem objective apontando o bloco da task', () => {
    const issue = onlyIssue(
      MINIMAL_MISSION_YAML.replace('    objective: Fazer a coisa certa\n', ''),
    )
    expect(issue.path).toBe('tasks[0].objective')
    expect(issue.line).toBe(12)
  })

  it('recusa objective vazio', () => {
    const issue = onlyIssue(
      MINIMAL_MISSION_YAML.replace('objective: Fazer a coisa certa', "objective: '   '"),
    )
    expect(issue.path).toBe('tasks[0].objective')
    expect(issue.line).toBe(15)
  })

  it('recusa title acima de 120 caracteres', () => {
    const issue = onlyIssue(MINIMAL_MISSION_YAML.replace('Missao de teste', 'x'.repeat(121)))
    expect(issue.path).toBe('title')
  })

  it('recusa acceptanceCriteria vazio', () => {
    const issue = onlyIssue(
      MINIMAL_MISSION_YAML.replace(
        'acceptanceCriteria:\n  - Criterio um\n',
        'acceptanceCriteria: []\n',
      ),
    )
    expect(issue.path).toBe('acceptanceCriteria')
  })

  it('recusa missao sem fase', () => {
    const issue = onlyIssue(
      MINIMAL_MISSION_YAML.replace('phases:\n  - id: core\n    title: Nucleo\n', 'phases: []\n'),
    )
    expect(issue.path).toBe('phases')
  })

  it('recusa fases com id repetido apontando a segunda', () => {
    const issue = onlyIssue(
      MINIMAL_MISSION_YAML.replace(
        '  - id: core\n    title: Nucleo\n',
        '  - id: core\n    title: Nucleo\n  - id: core\n    title: Repetida\n',
      ),
    )
    expect(issue.path).toBe('phases[1].id')
    expect(issue.message).toContain('repetido')
  })

  it('recusa missao sem task', () => {
    const text = `${MINIMAL_MISSION_YAML.slice(0, MINIMAL_MISSION_YAML.indexOf('tasks:'))}tasks: []\n`
    const issue = onlyIssue(text)
    expect(issue.path).toBe('tasks')
  })

  it(`recusa mais de ${MAX_TASKS_PER_MISSION} tasks`, () => {
    const head = MINIMAL_MISSION_YAML.slice(0, MINIMAL_MISSION_YAML.indexOf('tasks:'))
    const tasks = Array.from({ length: MAX_TASKS_PER_MISSION + 1 }, (_, i) => {
      const id = `T${String(i + 1).padStart(3, '0')}`
      return `  - id: ${id}\n    phase: core\n    title: Task ${id}\n    objective: Objetivo\n`
    }).join('')
    const issue = onlyIssue(`${head}tasks:\n${tasks}`)
    expect(issue.path).toBe('tasks')
  })

  it('recusa reviewPolicy invalida', () => {
    const issue = onlyIssue(
      MINIMAL_MISSION_YAML.replace(
        '    objective: Fazer a coisa certa\n',
        '    objective: Fazer a coisa certa\n    reviewPolicy: cross-provider-maybe\n',
      ),
    )
    expect(issue.path).toBe('tasks[0].reviewPolicy')
    expect(issue.line).toBe(16)
  })

  it('recusa maxAttempts menor que 1', () => {
    const issue = onlyIssue(
      MINIMAL_MISSION_YAML.replace(
        '    objective: Fazer a coisa certa\n',
        '    objective: Fazer a coisa certa\n    maxAttempts: 0\n',
      ),
    )
    expect(issue.path).toBe('tasks[0].maxAttempts')
  })

  it('recusa estimate zero ou negativo', () => {
    const issue = onlyIssue(
      MINIMAL_MISSION_YAML.replace(
        '    objective: Fazer a coisa certa\n',
        '    objective: Fazer a coisa certa\n    estimate: 0\n',
      ),
    )
    expect(issue.path).toBe('tasks[0].estimate')
  })

  it('recusa touches com ".." ou caminho absoluto', () => {
    const relative = onlyIssue(MINIMAL_MISSION_YAML.replace('packages/exemplo/', '../fora/'))
    expect(relative.path).toBe('tasks[0].touches[0]')
    expect(relative.line).toBe(17)

    const absolute = onlyIssue(MINIMAL_MISSION_YAML.replace('packages/exemplo/', '/etc/'))
    expect(absolute.path).toBe('tasks[0].touches[0]')
  })

  it('recusa risk desconhecido', () => {
    const issue = onlyIssue(
      MINIMAL_MISSION_YAML.replace(
        '    objective: Fazer a coisa certa\n',
        '    objective: Fazer a coisa certa\n    risk: critical\n',
      ),
    )
    expect(issue.path).toBe('tasks[0].risk')
  })

  it('recusa campo desconhecido na task', () => {
    const issue = onlyIssue(
      MINIMAL_MISSION_YAML.replace(
        '    objective: Fazer a coisa certa\n',
        '    objective: Fazer a coisa certa\n    ownerr: alguem\n',
      ),
    )
    expect(issue.path).toBe('tasks[0]')
    expect(issue.message).toContain('ownerr')
  })

  it('recusa campo desconhecido na raiz', () => {
    const issue = onlyIssue(`${MINIMAL_MISSION_YAML}deadline: 2026-01-01\n`)
    expect(issue.path).toBe('')
  })

  it('acumula varias issues numa passada', () => {
    const text = MINIMAL_MISSION_YAML.replace('agentic/v1', 'agentic/v3').replace(
      'DA-TEST-001',
      'nope',
    )
    const result = parseMissionFile(text)
    expect(issuesOf(result)).toHaveLength(2)
    expect(issueAt(result, 'apiVersion')).toBeDefined()
    expect(issueAt(result, 'id')).toBeDefined()
  })
})

describe('MissionFileSchema — missao com defaults', () => {
  it('parseia a missao completa com defaults e overrides', () => {
    const result = parseMissionFile(MISSION_WITH_DEFAULTS_YAML)
    expect(issuesOf(result)).toEqual([])
    if (!result.ok) throw new Error('deveria parsear')
    expect(result.value.tasks).toHaveLength(2)
    expect(result.value.defaults?.reviewPolicy).toBe('cross-provider-preferred')
  })
})
