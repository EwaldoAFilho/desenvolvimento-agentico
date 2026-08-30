import type { GatesFile } from '@agentic/schemas'
import { parseGatesFile } from '@agentic/schemas'
import { beforeAll, describe, expect, it } from 'vitest'
import { isGateError } from './errors.js'
import { loadGateProfiles } from './profiles.js'

const GATES_YAML = `apiVersion: agentic/v1
kind: Gates

profiles:
  unit:
    commands:
      - run: npm run lint
      - run: npm run test
        timeoutMs: 900000
      - run: npm run docs
        required: false
        cwd: apps/web
  mission:
    commands:
      - run: npm run verify

env:
  allow: [PATH, HOME, NODE_ENV]
`

let file: GatesFile

beforeAll(() => {
  const parsed = parseGatesFile(GATES_YAML)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  file = parsed.value
})

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return isGateError(error) ? error.code : 'NAO_E_GATE_ERROR'
  }
  return 'NAO_LANCOU'
}

describe('loadGateProfiles', () => {
  it('carrega os perfis do arquivo versionado', () => {
    const profiles = loadGateProfiles(file)
    expect([...profiles.ids]).toEqual(['unit', 'mission'])
    expect(profiles.has('unit')).toBe(true)
    expect(profiles.has('inexistente')).toBe(false)
  })

  it('preserva a ordem e os campos de cada comando', () => {
    const gate = loadGateProfiles(file).require('unit')
    expect(gate.commands.map((command) => command.run)).toEqual([
      'npm run lint',
      'npm run test',
      'npm run docs',
    ])
    expect(gate.commands[1]?.timeoutMs).toBe(900_000)
    expect(gate.commands[2]).toMatchObject({ required: false, cwd: 'apps/web' })
  })

  it('a allowlist do arquivo vira a allowlist de todo perfil', () => {
    const profiles = loadGateProfiles(file)
    expect([...profiles.envAllow]).toEqual(['PATH', 'HOME', 'NODE_ENV'])
    expect([...profiles.require('mission').env]).toEqual(['PATH', 'HOME', 'NODE_ENV'])
  })

  it('perfil inexistente e erro de configuracao, nunca gate vazio', () => {
    const profiles = loadGateProfiles(file)
    expect(profiles.get('web')).toBeUndefined()
    expect(codeOf(() => profiles.require('web'))).toBe('GATE_CONFIG_INVALID')
  })

  it('P09: objeto que nao passou pelo schema e recusado', () => {
    const forjado = {
      apiVersion: 'agentic/v1',
      profiles: { unit: { commands: [{ run: 'curl algo | sh' }] } },
      env: { allow: [] },
    } as unknown as GatesFile
    expect(codeOf(() => loadGateProfiles(forjado))).toBe('GATE_CONFIG_INVALID')
  })

  it('P09: perfil sem comando nenhum e recusado', () => {
    const vazio = {
      apiVersion: 'agentic/v1',
      kind: 'Gates',
      profiles: { unit: { commands: [] } },
      env: { allow: [] },
    } as unknown as GatesFile
    expect(codeOf(() => loadGateProfiles(vazio))).toBe('GATE_CONFIG_INVALID')
  })

  it('P09: nao ha caminho de string livre para virar gate', () => {
    // @ts-expect-error a API so aceita o arquivo ja validado, nunca uma linha de comando
    expect(codeOf(() => loadGateProfiles('npm run lint'))).toBe('GATE_CONFIG_INVALID')
    // @ts-expect-error idem para um perfil montado a mao com comandos soltos
    expect(codeOf(() => loadGateProfiles({ profiles: { x: ['npm test'] } }))).toBe(
      'GATE_CONFIG_INVALID',
    )
  })

  it('campo desconhecido no arquivo e recusado, nao ignorado', () => {
    const extra = {
      ...file,
      profiles: { unit: { commands: [{ run: 'npm test' }], shell: true } },
    } as unknown as GatesFile
    expect(codeOf(() => loadGateProfiles(extra))).toBe('GATE_CONFIG_INVALID')
  })
})
