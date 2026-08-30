import { describe, expect, it } from 'vitest'
import { MINIMAL_MISSION_YAML } from './__fixtures__/samples.js'
import { formatIssuePath, issuesOf } from './issues.js'
import { parseMissionFile } from './parse.js'
import { locateInYaml, parseYamlDocument, toPlainValue } from './yaml.js'

describe('parseYamlDocument', () => {
  it('devolve documento e contador de linhas para YAML valido', () => {
    const result = parseYamlDocument(MINIMAL_MISSION_YAML)
    if (!result.ok) throw new Error('deveria parsear')
    expect(toPlainValue(result.value)).toMatchObject({ kind: 'Mission', id: 'DA-TEST-001' })
  })

  it('devolve issue com linha para YAML sintaticamente quebrado', () => {
    const broken = 'apiVersion: agentic/v1\nkind: Mission\ntasks: [1, 2\nid: DA-TEST-001\n'
    const result = parseYamlDocument(broken)
    expect(result.ok).toBe(false)
    const issue = issuesOf(result)[0]
    expect(issue?.path).toBe('')
    expect(issue?.line).toBeGreaterThan(0)
    expect(issue?.column).toBeGreaterThan(0)
  })

  it('localiza no aninhado pelo caminho', () => {
    const result = parseYamlDocument(MINIMAL_MISSION_YAML)
    if (!result.ok) throw new Error('deveria parsear')
    expect(locateInYaml(result.value, ['tasks', 0, 'title'])).toEqual({ line: 14, column: 12 })
    expect(locateInYaml(result.value, ['phases', 0, 'id'])).toEqual({ line: 9, column: 9 })
  })

  it('sobe para o no pai quando o campo nao existe no documento', () => {
    const result = parseYamlDocument(MINIMAL_MISSION_YAML)
    if (!result.ok) throw new Error('deveria parsear')
    expect(locateInYaml(result.value, ['tasks', 0, 'inexistente'])).toEqual({ line: 12, column: 5 })
  })

  it('nao lanca quando o caminho nao existe de todo', () => {
    const result = parseYamlDocument(MINIMAL_MISSION_YAML)
    if (!result.ok) throw new Error('deveria parsear')
    expect(locateInYaml(result.value, ['nada', 42, 'aqui'])).toEqual({ line: 1, column: 1 })
  })
})

describe('parseMissionFile sobre YAML invalido', () => {
  it('nunca lanca: erro de sintaxe vira issue localizada', () => {
    const broken = `${MINIMAL_MISSION_YAML}\n\ttab: proibido\n`
    const result = parseMissionFile(broken)
    expect(result.ok).toBe(false)
    const issue = issuesOf(result)[0]
    expect(issue?.line).toBeGreaterThan(0)
    expect(issue?.message.length).toBeGreaterThan(0)
  })

  it('documento vazio vira issue de tipo, nao excecao', () => {
    const result = parseMissionFile('')
    expect(result.ok).toBe(false)
    expect(issuesOf(result)).toHaveLength(1)
  })

  it('documento que nao e mapa vira issue de tipo', () => {
    const result = parseMissionFile('- um\n- dois\n')
    expect(result.ok).toBe(false)
    expect(issuesOf(result)[0]?.path).toBe('')
  })
})

describe('formatIssuePath', () => {
  it('formata raiz, campo, indice e aninhamento', () => {
    expect(formatIssuePath([])).toBe('')
    expect(formatIssuePath(['apiVersion'])).toBe('apiVersion')
    expect(formatIssuePath(['tasks', 3, 'objective'])).toBe('tasks[3].objective')
    expect(formatIssuePath(['providers', 'registry', 'mock', 'roles', 0])).toBe(
      'providers.registry.mock.roles[0]',
    )
  })
})
