import { describe, expect, it } from 'vitest'
import { MINIMAL_GATES_YAML } from './__fixtures__/samples.js'
import { issuesOf, type SchemaIssue } from './issues.js'
import { parseGatesFile } from './parse.js'

function onlyIssue(text: string): SchemaIssue {
  const issues = issuesOf(parseGatesFile(text))
  expect(issues).toHaveLength(1)
  const issue = issues[0]
  if (issue === undefined) throw new Error('esperava exatamente uma issue')
  return issue
}

describe('GatesFileSchema', () => {
  it('aceita o arquivo minimo', () => {
    const result = parseGatesFile(MINIMAL_GATES_YAML)
    expect(issuesOf(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('preserva required false e timeoutMs por comando', () => {
    const result = parseGatesFile(MINIMAL_GATES_YAML)
    if (!result.ok) throw new Error('deveria parsear')
    const commands = result.value.profiles.unit?.commands ?? []
    expect(commands[0]).toEqual({ run: 'npm run lint' })
    expect(commands[1]).toEqual({ run: 'npm run test', timeoutMs: 900_000, required: false })
  })

  it('preenche env.allow ausente com lista vazia', () => {
    const text = MINIMAL_GATES_YAML.replace('env:\n  allow: [PATH, HOME]\n', '')
    const result = parseGatesFile(text)
    if (!result.ok) throw new Error('deveria parsear')
    expect(result.value.env.allow).toEqual([])
  })

  it('aceita cwd relativo ao workspace da tentativa', () => {
    const text = MINIMAL_GATES_YAML.replace(
      '      - run: npm run lint\n',
      '      - run: npm run lint\n        cwd: apps/api\n',
    )
    const result = parseGatesFile(text)
    if (!result.ok) throw new Error('deveria parsear')
    expect(result.value.profiles.unit?.commands[0]?.cwd).toBe('apps/api')
  })

  it('recusa kind diferente de Gates', () => {
    const issue = onlyIssue(MINIMAL_GATES_YAML.replace('kind: Gates', 'kind: Mission'))
    expect(issue.path).toBe('kind')
    expect(issue.line).toBe(2)
  })

  it('recusa apiVersion desconhecida', () => {
    const issue = onlyIssue(MINIMAL_GATES_YAML.replace('agentic/v1', 'agentic/v2'))
    expect(issue.path).toBe('apiVersion')
    expect(issue.line).toBe(1)
  })

  it('recusa perfil sem commands', () => {
    const text = `apiVersion: agentic/v1\nkind: Gates\nprofiles:\n  unit: {}\n`
    const issue = onlyIssue(text)
    expect(issue.path).toBe('profiles.unit.commands')
    expect(issue.line).toBe(4)
  })

  it('recusa perfil com lista de comandos vazia', () => {
    const text = `apiVersion: agentic/v1\nkind: Gates\nprofiles:\n  unit:\n    commands: []\n`
    const issue = onlyIssue(text)
    expect(issue.path).toBe('profiles.unit.commands')
    expect(issue.message).toContain('comando')
  })

  it('recusa comando sem run', () => {
    const text = MINIMAL_GATES_YAML.replace(
      '      - run: npm run lint\n',
      '      - timeoutMs: 10\n',
    )
    const issue = onlyIssue(text)
    expect(issue.path).toBe('profiles.unit.commands[0].run')
  })

  it('recusa timeoutMs negativo', () => {
    const issue = onlyIssue(MINIMAL_GATES_YAML.replace('timeoutMs: 900000', 'timeoutMs: -1'))
    expect(issue.path).toBe('profiles.unit.commands[1].timeoutMs')
  })

  it('recusa id de perfil fora do formato', () => {
    const text = MINIMAL_GATES_YAML.replace('  unit:', '  "perfil invalido":')
    const issue = onlyIssue(text)
    expect(issue.path).toBe('profiles.perfil invalido')
  })

  it('recusa campo desconhecido no comando', () => {
    const text = MINIMAL_GATES_YAML.replace(
      '      - run: npm run lint\n',
      '      - run: npm run lint\n        retries: 3\n',
    )
    const issue = onlyIssue(text)
    expect(issue.path).toBe('profiles.unit.commands[0]')
    expect(issue.message).toContain('retries')
  })
})
