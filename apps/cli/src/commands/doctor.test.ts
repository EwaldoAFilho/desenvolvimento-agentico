import { afterEach, describe, expect, it } from 'vitest'
import {
  captureDeps,
  createWorkspace,
  fakeRegistry,
  health,
  type Workspace,
} from '../__fixtures__/harness.js'
import { EXIT_ERROR, EXIT_OK } from '../result.js'
import { type DoctorData, doctorCommand } from './doctor.js'
import { providersCommand } from './providers.js'

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

const MOCK_OK = health({
  providerId: 'mock',
  installed: true,
  ready: true,
  version: '1.0.0-mock',
  detail: 'agente in-process',
  capacity: 4,
})

/** Sonda que nao consegue apurar prontidao: o caso do R5. */
const UNKNOWN_CLI = health({
  providerId: 'cli-local',
  installed: 'unknown',
  ready: 'unknown',
  version: 'unknown',
  detail: 'a CLI nao expoe verificacao de sessao',
  capacity: 2,
})

function dataOf(result: { readonly data?: unknown }): DoctorData {
  return result.data as DoctorData
}

describe('doctor', () => {
  it('shared com maxParallelTasks 3 e erro de configuracao', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 3 })
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () => fakeRegistry([MOCK_OK]),
    })
    const result = await doctorCommand({}, captured.deps)
    const check = dataOf(result).checks.find((item) => item.id === 'workspace.shared-parallel')

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(result.error?.code).toBe('ENVIRONMENT_INVALID')
    expect(check?.status).toBe('error')
    expect(check?.detail).toContain('maxParallelTasks: 3')
    expect(captured.stdout()).toContain('ERRO')
  })

  it('controle: shared com maxParallelTasks 1 passa', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () => fakeRegistry([MOCK_OK]),
    })
    const result = await doctorCommand({}, captured.deps)
    const check = dataOf(result).checks.find((item) => item.id === 'workspace.shared-parallel')

    expect(result.exitCode).toBe(EXIT_OK)
    expect(check?.status).toBe('ok')
    expect(dataOf(result).ok).toBe(true)
  })

  it('exige repositorio git quando o workspace e git-worktree', async () => {
    workspace = await createWorkspace({ workspace: 'git-worktree' })
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () => fakeRegistry([MOCK_OK]),
      probeGit: () =>
        Promise.resolve({
          installed: true,
          version: 'git version 2.43.0',
          repository: false,
          detail: 'fora de repositorio',
        }),
    })
    const result = await doctorCommand({}, captured.deps)
    const check = dataOf(result).checks.find((item) => item.id === 'git.repository')

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(check?.status).toBe('error')
  })

  it('em modo shared, ausencia de repositorio git e apenas aviso', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () => fakeRegistry([MOCK_OK]),
      probeGit: () =>
        Promise.resolve({
          installed: true,
          version: 'git version 2.43.0',
          repository: false,
          detail: 'fora de repositorio',
        }),
    })
    const result = await doctorCommand({}, captured.deps)
    const check = dataOf(result).checks.find((item) => item.id === 'git.repository')

    expect(check?.status).toBe('warn')
    expect(result.exitCode).toBe(EXIT_OK)
  })

  it('git ausente e erro de ambiente', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () => fakeRegistry([MOCK_OK]),
      probeGit: () =>
        Promise.resolve({
          installed: false,
          version: 'unknown',
          repository: false,
          detail: 'ENOENT',
        }),
    })
    const result = await doctorCommand({}, captured.deps)

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(dataOf(result).checks.find((item) => item.id === 'git.installed')?.status).toBe('error')
  })

  it('node abaixo do minimo e erro', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    const captured = captureDeps({
      cwd: workspace.dir,
      nodeVersion: '18.19.0',
      registry: () => fakeRegistry([MOCK_OK]),
    })
    const result = await doctorCommand({}, captured.deps)

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(dataOf(result).checks.find((item) => item.id === 'node.version')?.status).toBe('error')
  })

  it('provider com sonda inconclusiva sai como unknown, nunca como pronto', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () => fakeRegistry([UNKNOWN_CLI]),
    })
    const result = await doctorCommand({}, captured.deps)
    const check = dataOf(result).checks.find((item) => item.id === 'provider.cli-local')
    const row = captured
      .stdout()
      .split('\n')
      .find((line) => line.includes('cli-local') && line.includes('unknown'))

    expect(check?.status).toBe('unknown')
    expect(result.exitCode).toBe(EXIT_OK)
    expect(row).toBeDefined()
    expect(row).not.toMatch(/\bsim\b/)
    expect(row).not.toMatch(/\bok\b/)
    expect(row).not.toMatch(/\btrue\b/)
    expect(row).not.toContain('✔')
  })

  it('provider instalado e nao pronto e erro; nunca vira unknown silencioso', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () =>
        fakeRegistry([
          health({ providerId: 'cli-local', installed: true, ready: false, version: '2.0.0' }),
        ]),
    })
    const result = await doctorCommand({}, captured.deps)

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(dataOf(result).checks.find((item) => item.id === 'provider.cli-local')?.status).toBe(
      'error',
    )
  })

  it('avisa quando o teto global excede a capacidade somada dos fornecedores', async () => {
    workspace = await createWorkspace({ workspace: 'git-worktree', maxParallelTasks: 9 })
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () => fakeRegistry([MOCK_OK]),
    })
    const result = await doctorCommand({}, captured.deps)
    const check = dataOf(result).checks.find((item) => item.id === 'providers.capacity')

    expect(check?.status).toBe('warn')
    expect(result.exitCode).toBe(EXIT_OK)
  })

  it('--json devolve checks e providers no envelope', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () => fakeRegistry([UNKNOWN_CLI]),
    })
    const result = await doctorCommand({ json: true }, captured.deps)

    expect(captured.stdout()).toBe('')
    expect(dataOf(result).providers[0]).toMatchObject({
      providerId: 'cli-local',
      installed: 'unknown',
      ready: 'unknown',
    })
  })
})

describe('providers', () => {
  it('imprime unknown como unknown', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () => fakeRegistry([UNKNOWN_CLI]),
    })
    const result = await providersCommand({}, captured.deps)
    const row = captured
      .stdout()
      .split('\n')
      .find((line) => line.startsWith('cli-local'))

    expect(result.exitCode).toBe(EXIT_OK)
    expect(row).toBe('cli-local   unknown    unknown  unknown  0       2')
    expect(row).not.toMatch(/\bsim\b|\bok\b|\btrue\b/)
  })

  it('mostra instalado, pronto, versao, em uso e capacidade', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () => fakeRegistry([{ ...MOCK_OK, running: 2 }]),
    })
    const result = await providersCommand({}, captured.deps)
    const text = captured.stdout()

    expect(text).toContain('FORNECEDOR')
    expect(text).toContain('INSTALADO')
    expect(text).toContain('CAPACIDADE')
    expect(text).toMatch(/mock\s+sim\s+sim\s+1\.0\.0-mock\s+2\s+4/)
    expect(result.data).toHaveLength(1)
  })

  it('capacidade nula aparece como sem teto', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () => fakeRegistry([health({ providerId: 'sem-teto', capacity: null })]),
    })
    await providersCommand({}, captured.deps)

    expect(captured.stdout()).toContain('sem teto')
  })

  it('--json devolve ProviderHealthDto', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () => fakeRegistry([UNKNOWN_CLI]),
    })
    const result = await providersCommand({ json: true }, captured.deps)

    expect(captured.stdout()).toBe('')
    expect(result.data).toEqual([
      {
        providerId: 'cli-local',
        installed: 'unknown',
        ready: 'unknown',
        version: 'unknown',
        detail: 'a CLI nao expoe verificacao de sessao',
        running: 0,
        capacity: 2,
        probedAt: '2026-01-01T00:00:00.000Z',
      },
    ])
  })
})
