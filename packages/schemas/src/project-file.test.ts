import { describe, expect, it } from 'vitest'
import { MINIMAL_PROJECT_YAML } from './__fixtures__/samples.js'
import { issuesOf, type SchemaIssue } from './issues.js'
import { parseProjectFile } from './parse.js'

function onlyIssue(text: string): SchemaIssue {
  const issues = issuesOf(parseProjectFile(text))
  expect(issues).toHaveLength(1)
  const issue = issues[0]
  if (issue === undefined) throw new Error('esperava exatamente uma issue')
  return issue
}

describe('ProjectFileSchema — valido', () => {
  it('aceita o projeto minimo', () => {
    const result = parseProjectFile(MINIMAL_PROJECT_YAML)
    expect(issuesOf(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('preenche integration, gates e server com defaults', () => {
    const result = parseProjectFile(MINIMAL_PROJECT_YAML)
    if (!result.ok) throw new Error('deveria parsear')
    expect(result.value.integration).toEqual({
      missionBranchPrefix: 'mission/',
      taskBranchPrefix: 'task/',
      strategy: 'rebase-merge',
      autoPush: false,
    })
    expect(result.value.gates.file).toBe('.agentic/gates.yaml')
    expect(result.value.server).toEqual({ host: '127.0.0.1', port: 4317 })
  })

  it('preenche workspaceSetup ausente com valores vazios e timeout padrao', () => {
    const result = parseProjectFile(MINIMAL_PROJECT_YAML)
    if (!result.ok) throw new Error('deveria parsear')
    expect(result.value.execution.workspaceSetup).toEqual({
      link: [],
      commands: [],
      timeoutMs: 600_000,
    })
  })

  it('aceita workspaceSetup com link e comando', () => {
    const text = MINIMAL_PROJECT_YAML.replace(
      '  retryBackoffSeconds: 15\n',
      '  retryBackoffSeconds: 15\n  workspaceSetup:\n    link: [node_modules, .env]\n    commands:\n      - run: npm ci --prefer-offline\n        timeoutMs: 120000\n',
    )
    const result = parseProjectFile(text)
    if (!result.ok) throw new Error('deveria parsear')
    expect(result.value.execution.workspaceSetup.link).toEqual(['node_modules', '.env'])
    expect(result.value.execution.workspaceSetup.commands[0]?.run).toBe('npm ci --prefer-offline')
  })

  it('preenche roles ausente com executor e reviewer', () => {
    const result = parseProjectFile(MINIMAL_PROJECT_YAML)
    if (!result.ok) throw new Error('deveria parsear')
    expect(result.value.providers.registry.mock?.roles).toEqual(['executor', 'reviewer'])
  })

  it('aceita denyPaths com glob, que nao e PathScope', () => {
    const text = MINIMAL_PROJECT_YAML.replace(
      'policies:\n',
      'policies:\n  denyPaths:\n    - .agentic/\n    - "*.pem"\n',
    )
    const result = parseProjectFile(text)
    if (!result.ok) throw new Error('deveria parsear')
    expect(result.value.policies.denyPaths).toEqual(['.agentic/', '*.pem'])
  })

  it('aceita perfis de agente no registry', () => {
    const text = MINIMAL_PROJECT_YAML.replace(
      '      roles: [executor, reviewer]\n',
      '      roles: [executor, reviewer]\n      profiles:\n        executor: { role: executor }\n        reviewer: { role: reviewer }\n',
    )
    const result = parseProjectFile(text)
    if (!result.ok) throw new Error('deveria parsear')
    expect(result.value.providers.registry.primario?.profiles?.reviewer?.role).toBe('reviewer')
  })
})

describe('ProjectFileSchema — invalido com localizacao', () => {
  it('recusa maxConcurrent ausente', () => {
    const issue = onlyIssue(MINIMAL_PROJECT_YAML.replace('      maxConcurrent: 3\n', ''))
    expect(issue.path).toBe('providers.registry.primario.maxConcurrent')
    expect(issue.line).toBeGreaterThan(0)
  })

  it('recusa roles vazio', () => {
    const issue = onlyIssue(
      MINIMAL_PROJECT_YAML.replace('roles: [executor, reviewer]', 'roles: []'),
    )
    expect(issue.path).toBe('providers.registry.primario.roles')
    expect(issue.message).toContain('papel')
  })

  it('recusa papel desconhecido', () => {
    const issue = onlyIssue(
      MINIMAL_PROJECT_YAML.replace('roles: [executor, reviewer]', 'roles: [integrator]'),
    )
    expect(issue.path).toBe('providers.registry.primario.roles[0]')
  })

  it('recusa provider local-cli sem command', () => {
    const issue = onlyIssue(MINIMAL_PROJECT_YAML.replace('      command: agente-a\n', ''))
    expect(issue.path).toBe('providers.registry.primario.command')
    expect(issue.message).toContain('local-cli')
  })

  it('recusa kind de provider desconhecido', () => {
    const issue = onlyIssue(MINIMAL_PROJECT_YAML.replace('kind: inprocess', 'kind: remote-api'))
    expect(issue.path).toBe('providers.registry.mock.kind')
  })

  it('recusa registry vazio', () => {
    const text = `${MINIMAL_PROJECT_YAML.slice(0, MINIMAL_PROJECT_YAML.indexOf('  registry:'))}  registry: {}\n`
    const issue = onlyIssue(text)
    expect(issue.path).toBe('providers.registry')
  })

  it('recusa workspace desconhecido', () => {
    const issue = onlyIssue(
      MINIMAL_PROJECT_YAML.replace('workspace: git-worktree', 'workspace: nfs'),
    )
    expect(issue.path).toBe('execution.workspace')
    expect(issue.line).toBe(6)
  })

  it('recusa maxParallelTasks zero', () => {
    const issue = onlyIssue(
      MINIMAL_PROJECT_YAML.replace('maxParallelTasks: 2', 'maxParallelTasks: 0'),
    )
    expect(issue.path).toBe('execution.maxParallelTasks')
  })

  it('recusa politica de revisao sem o mapa completo de risco', () => {
    const issue = onlyIssue(
      MINIMAL_PROJECT_YAML.replace('      high: cross-provider-required\n', ''),
    )
    expect(issue.path).toBe('policies.review.byRisk.high')
  })

  it('recusa politica de revisao default invalida', () => {
    const issue = onlyIssue(
      MINIMAL_PROJECT_YAML.replace('default: fresh-session', 'default: nenhuma'),
    )
    expect(issue.path).toBe('policies.review.default')
  })

  it('recusa policies sem review', () => {
    const text = MINIMAL_PROJECT_YAML.replace(
      /policies:\n( {2}.*\n)+providers:/,
      'policies: {}\nproviders:',
    )
    const issue = onlyIssue(text)
    expect(issue.path).toBe('policies.review')
  })

  it('recusa escalateOn com gatilho desconhecido', () => {
    const text = MINIMAL_PROJECT_YAML.replace(
      'policies:\n',
      'policies:\n  escalateOn: [attemptsExhausted, cafeAcabou]\n',
    )
    const issue = onlyIssue(text)
    expect(issue.path).toBe('policies.escalateOn[1]')
  })

  it('recusa apiVersion desconhecida', () => {
    const issue = onlyIssue(MINIMAL_PROJECT_YAML.replace('agentic/v1', 'agentic/v9'))
    expect(issue.path).toBe('apiVersion')
    expect(issue.line).toBe(1)
  })

  it('recusa kind diferente de Project', () => {
    const issue = onlyIssue(MINIMAL_PROJECT_YAML.replace('kind: Project', 'kind: Mission'))
    expect(issue.path).toBe('kind')
  })

  it('recusa campo desconhecido em execution', () => {
    const issue = onlyIssue(
      MINIMAL_PROJECT_YAML.replace('  maxExecutors: 2\n', '  maxExecutors: 2\n  maxAgentes: 9\n'),
    )
    expect(issue.path).toBe('execution')
    expect(issue.message).toContain('maxAgentes')
  })
})
