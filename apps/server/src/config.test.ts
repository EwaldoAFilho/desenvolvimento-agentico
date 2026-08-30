import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gatesYaml, projectYaml } from './__fixtures__/files.js'
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  loadProjectSources,
  resolveBind,
  ServerConfigError,
} from './config.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function seed(project: string, gates?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentic-config-'))
  await mkdir(join(dir, '.agentic'), { recursive: true })
  await writeFile(join(dir, '.agentic', 'project.yaml'), project, 'utf8')
  if (gates !== undefined) await writeFile(join(dir, '.agentic', 'gates.yaml'), gates, 'utf8')
  return dir
}

describe('bind de rede (ARCHITECTURE 9)', () => {
  it('sem configuracao alguma fica no loopback', () => {
    expect(resolveBind()).toEqual({ host: DEFAULT_HOST, port: DEFAULT_PORT, exposed: false })
  })

  it('usa host e porta do project.yaml quando declarados', () => {
    const project = { server: { host: '127.0.0.1', port: 5555 } }
    expect(resolveBind({}, project as never)).toEqual({
      host: '127.0.0.1',
      port: 5555,
      exposed: false,
    })
  })

  it('a flag explicita vence o project.yaml', () => {
    const project = { server: { host: '127.0.0.1', port: 5555 } }
    expect(resolveBind({ port: 9999 }, project as never).port).toBe(9999)
  })

  it('recusa expor fora do loopback sem flag explicita', () => {
    expect(() => resolveBind({ host: '0.0.0.0' })).toThrow(ServerConfigError)
  })

  it('expoe apenas com a flag explicita e marca o retrato como exposto', () => {
    expect(resolveBind({ host: '0.0.0.0', exposeExternally: true })).toEqual({
      host: '0.0.0.0',
      port: DEFAULT_PORT,
      exposed: true,
    })
  })

  it('trata ::1 e localhost como loopback', () => {
    expect(resolveBind({ host: '::1' }).exposed).toBe(false)
    expect(resolveBind({ host: 'localhost' }).exposed).toBe(false)
  })
})

describe('carga dos arquivos do projeto', () => {
  it('le project.yaml e o gates.yaml apontado por ele', async () => {
    root = await seed(projectYaml(), gatesYaml())
    const sources = await loadProjectSources({ repoRoot: root })
    expect(sources.project.kind).toBe('Project')
    expect(sources.gatesFile.kind).toBe('Gates')
    expect(sources.projectText).toContain('kind: Project')
    expect(sources.gatesText).toContain('kind: Gates')
  })

  it('sem project.yaml devolve erro de configuracao com codigo', async () => {
    root = await mkdtemp(join(tmpdir(), 'agentic-config-'))
    await expect(loadProjectSources({ repoRoot: root })).rejects.toThrow(ServerConfigError)
  })

  it('project.yaml invalido carrega as issues do schema', async () => {
    root = await seed('apiVersion: agentic/v1\nkind: Nada\n')
    const failure = await loadProjectSources({ repoRoot: root }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ServerConfigError)
    expect((failure as ServerConfigError).code).toBe('PROJECT_FILE_INVALID')
    expect((failure as ServerConfigError).issues.length).toBeGreaterThan(0)
  })

  it('bind efetivo do project.yaml de teste continua sendo 127.0.0.1', async () => {
    root = await seed(projectYaml(), gatesYaml())
    const sources = await loadProjectSources({ repoRoot: root })
    expect(resolveBind({}, sources.project).host).toBe('127.0.0.1')
  })
})
