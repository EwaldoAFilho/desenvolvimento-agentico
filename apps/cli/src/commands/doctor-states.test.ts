import type { ProviderHealth } from '@agentic/domain'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureDeps,
  createWorkspace,
  fakeRegistry,
  health,
  type Workspace,
} from '../__fixtures__/harness.js'
import { MASK } from '../redact.js'
import { EXIT_ERROR, EXIT_OK } from '../result.js'
import { type DoctorData, doctorCommand } from './doctor.js'

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

function dataOf(result: { readonly data?: unknown }): DoctorData {
  return result.data as DoctorData
}

async function runDoctor(
  entries: readonly ProviderHealth[],
): Promise<{ result: Awaited<ReturnType<typeof doctorCommand>>; text: string }> {
  workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
  const captured = captureDeps({ cwd: workspace.dir, registry: () => fakeRegistry(entries) })
  const result = await doctorCommand({}, captured.deps)
  return { result, text: captured.stdout() }
}

/** O caso REAL deste ambiente: link presente, instalacao apontada pelo link ausente. */
const BROKEN_LINK = health({
  providerId: 'mock',
  installed: false,
  ready: false,
  version: 'unknown',
  detail: 'instalacao: "cli" e um symlink quebrado',
  capacity: 2,
  readinessSource: 'prontidao false por ausencia do executavel',
  diagnostic: {
    kind: 'broken-symlink',
    detail:
      '"cli" e um symlink quebrado: /home/u/.local/bin/cli aponta para /snap/versions/2.1.220',
    target: '/snap/versions/2.1.220',
    remediation:
      'recrie o link para uma instalacao existente (`ln -sfn <caminho-real> /home/u/.local/bin/cli`)',
  },
})

describe('doctor distingue os cinco estados na saida humana', () => {
  it('READY aparece nominalmente', async () => {
    const { text } = await runDoctor([
      health({ providerId: 'mock', installed: true, ready: true, version: '1.0.0' }),
    ])
    expect(text).toContain('mock  READY')
  })

  it('INSTALLED nao vira READY quando a prontidao nao foi apurada', async () => {
    const { text, result } = await runDoctor([
      health({ providerId: 'mock', installed: true, ready: 'unknown', version: '1.0.0' }),
    ])
    expect(text).toContain('mock  INSTALLED')
    expect(text).not.toContain('mock  READY')
    // Prontidao nao apurada NAO reprova o ambiente (R5).
    expect(result.exitCode).toBe(EXIT_OK)
  })

  it('NOT_READY reprova o ambiente', async () => {
    const { text, result } = await runDoctor([
      health({ providerId: 'mock', installed: true, ready: false, version: '1.0.0' }),
    ])
    expect(text).toContain('mock  NOT_READY')
    expect(result.exitCode).toBe(EXIT_ERROR)
  })

  it('UNKNOWN sai como unknown e nao reprova', async () => {
    const { text, result } = await runDoctor([health({ providerId: 'mock' })])
    expect(text).toContain('mock  UNKNOWN')
    expect(result.exitCode).toBe(EXIT_OK)
    expect(text).toContain('`unknown` significa que nao foi possivel apurar')
  })

  it('NOT_INSTALLED reprova e diz O QUE FAZER, com alvo do symlink', async () => {
    const { text, result } = await runDoctor([BROKEN_LINK])

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(text).toContain('mock  NOT_INSTALLED')
    expect(text).toContain('instalado      nao')
    expect(text).toContain('[broken-symlink]')
    expect(text).toContain('/snap/versions/2.1.220 (nao existe)')
    expect(text).toContain('conserto       recrie o link')
  })

  it('o conserto tambem entra no check, nao so no bloco', async () => {
    const { result } = await runDoctor([BROKEN_LINK])
    const check = dataOf(result).checks.find((item) => item.id === 'provider.mock')

    expect(check?.status).toBe('error')
    expect(check?.detail).toContain('NOT_INSTALLED')
    expect(check?.detail).toContain('conserto:')
  })

  it('a tabela final tambem carrega o estado, ao lado de instalado e pronto', async () => {
    const { text } = await runDoctor([
      health({ providerId: 'mock', installed: true, ready: 'unknown', version: '9.9.9' }),
    ])
    expect(text).toContain('ESTADO')
    expect(text).toMatch(/mock\s+INSTALLED\s+sim\s+unknown\s+9\.9\.9/)
  })

  it('caminho resolvido e origem da prontidao aparecem quando existem', async () => {
    const { text } = await runDoctor([
      health({
        providerId: 'mock',
        installed: true,
        ready: true,
        version: '2.1.4',
        resolvedPath: '/usr/local/bin/mock',
        readinessSource: 'sonda de sessao saiu 0',
      }),
    ])
    expect(text).toContain('caminho        /usr/local/bin/mock')
    expect(text).toContain('origem: sonda de sessao saiu 0')
  })
})

describe('doctor nunca imprime token, e-mail ou organizacao', () => {
  it('e-mail que vazou para `detail` sai mascarado', async () => {
    const { text } = await runDoctor([
      health({
        providerId: 'mock',
        installed: true,
        ready: true,
        detail: 'sessao de pessoa@exemplo.invalid na organizacao ACME',
      }),
    ])

    expect(text).not.toContain('pessoa@exemplo.invalid')
    expect(text).toContain(MASK)
  })

  it('token no diagnostico sai mascarado, inclusive na remediacao', async () => {
    const { text } = await runDoctor([
      health({
        providerId: 'mock',
        installed: true,
        ready: false,
        detail: 'sonda reprovou',
        diagnostic: {
          kind: 'probe-failed',
          detail: 'ANTHROPIC_API_KEY=sk-abcdefgh12345678 presente no ambiente',
          remediation: 'remova sk-abcdefgh12345678 do ambiente',
        },
      }),
    ])

    expect(text).not.toContain('sk-abcdefgh12345678')
    expect(text).toContain(MASK)
  })

  it('a saida --json passa pelo mesmo filtro que a humana', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () =>
        fakeRegistry([
          health({
            providerId: 'mock',
            installed: true,
            ready: true,
            detail: 'sessao de alguem@empresa.com',
          }),
        ]),
    })
    const result = await doctorCommand({ json: true }, captured.deps)

    expect(JSON.stringify(dataOf(result).providerStates)).not.toContain('alguem@empresa.com')
  })
})

describe('contrato do --json do doctor', () => {
  it('mantem `ok`, `checks` e `providers` e acrescenta `providerStates` e `runningSource`', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () => fakeRegistry([health({ providerId: 'mock', installed: true, ready: true })]),
    })
    const result = await doctorCommand({ json: true }, captured.deps)

    expect(Object.keys(dataOf(result)).sort()).toEqual([
      'checks',
      'ok',
      'providerStates',
      'providers',
      'runningSource',
    ])
  })

  it('cada `providerState` carrega os nove campos do contrato', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () =>
        fakeRegistry([
          health({
            providerId: 'mock',
            installed: true,
            ready: 'unknown',
            version: '1.0.0',
            resolvedPath: '/usr/bin/mock',
            readinessSource: 'a CLI nao expoe sessao',
          }),
        ]),
    })
    const result = await doctorCommand({ json: true }, captured.deps)

    expect(dataOf(result).providerStates[0]).toEqual({
      provider: 'mock',
      state: 'INSTALLED',
      installed: true,
      executable: '(in-process)',
      resolvedPath: '/usr/bin/mock',
      version: '1.0.0',
      ready: 'unknown',
      readinessSource: 'a CLI nao expoe sessao',
      running: 0,
      capacity: 1,
      detail: 'sonda nao conclusiva',
    })
  })

  it('`--json` nao imprime nada em stdout alem do envelope', async () => {
    workspace = await createWorkspace({ workspace: 'shared', maxParallelTasks: 1 })
    const captured = captureDeps({
      cwd: workspace.dir,
      registry: () => fakeRegistry([health({ providerId: 'mock' })]),
    })
    await doctorCommand({ json: true }, captured.deps)

    expect(captured.stdout()).toBe('')
  })
})
