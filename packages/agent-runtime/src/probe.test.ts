import { rmSync } from 'node:fs'
import nodeProcess from 'node:process'
import type { ProviderCapabilities } from '@agentic/domain'
import { afterAll, describe, expect, it } from 'vitest'
import { FAKE_CLI, makeFakeCli, PROVIDER, spec } from './__fixtures__/fake-cli.js'
import { CapacityLedger } from './capacity.js'
import { extractVersion, probeLocalAgent } from './probe.js'
import type { LocalAgentRuntimeDeps } from './types.js'

const cli = makeFakeCli()

const base: LocalAgentRuntimeDeps = {
  platform: 'linux',
  pathEnv: cli.dir,
  probeCwd: cli.dir,
  probeTimeoutMs: 4000,
  processDeps: { killGraceMs: 200, closeGraceMs: 300 },
}

const withDeps = (extra: Partial<LocalAgentRuntimeDeps> = {}): LocalAgentRuntimeDeps => ({
  ...base,
  ...extra,
})

const CAPS = (readinessProbe: 'supported' | 'unsupported'): ProviderCapabilities => ({
  roles: ['executor', 'reviewer'],
  streaming: true,
  cancellation: true,
  readinessProbe,
  reportsUsage: false,
})

afterAll(() => {
  rmSync(cli.dir, { recursive: true, force: true })
})

describe('probeLocalAgent — instalacao', () => {
  it('executavel inexistente devolve installed false e ready false, sem excecao', async () => {
    const health = await probeLocalAgent(
      spec({ executable: 'cli-inexistente-xyz', versionArgs: ['--version'] }),
      {},
      withDeps(),
    )
    expect(health.installed).toBe(false)
    expect(health.ready).toBe(false)
    expect(health.version).toBe('unknown')
    expect(health.providerId).toBe(PROVIDER)
  })

  it('executavel encontrado devolve installed true', async () => {
    const health = await probeLocalAgent(spec(), {}, withDeps())
    expect(health.installed).toBe(true)
  })

  it('falha inesperada da checagem devolve installed unknown — nunca infere', async () => {
    const health = await probeLocalAgent(
      spec({ versionArgs: ['--version'], readinessArgs: ['--pronto'] }),
      {},
      withDeps({
        isExecutableFile: () => Promise.reject(new Error('io quebrado')),
      }),
    )
    expect(health.installed).toBe('unknown')
    expect(health.ready).toBe('unknown')
    expect(health.version).toBe('unknown')
  })
})

describe('probeLocalAgent — versao', () => {
  it('extrai a versao da saida de versionArgs', async () => {
    const health = await probeLocalAgent(spec({ versionArgs: ['--version'] }), {}, withDeps())
    expect(health.installed).toBe(true)
    expect(health.version).toBe('1.2.3')
  })

  it('le versao impressa em stderr', async () => {
    const health = await probeLocalAgent(
      spec({ versionArgs: ['--version-stderr'] }),
      {},
      withDeps(),
    )
    expect(health.version).toBe('9.8.7')
  })

  it('saida ilegivel vira version unknown', async () => {
    const health = await probeLocalAgent(spec({ versionArgs: ['--version-mudo'] }), {}, withDeps())
    expect(health.version).toBe('unknown')
    expect(health.installed).toBe(true)
  })

  it('spec sem versionArgs nao inventa versao', async () => {
    const health = await probeLocalAgent(spec(), {}, withDeps())
    expect(health.version).toBe('unknown')
    expect(health.detail).toContain('sem versionArgs')
  })

  it('versionArgs que trava respeita o timeout e nao segura o probe', async () => {
    const started = Date.now()
    const health = await probeLocalAgent(
      spec({ versionArgs: ['--version-lenta'] }),
      {},
      withDeps({ probeTimeoutMs: 250 }),
    )
    expect(health.version).toBe('unknown')
    expect(health.installed).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

describe('probeLocalAgent — prontidao', () => {
  it('--version que respondeu NAO vira ready true', async () => {
    // Regra de honestidade (DOMAIN-MODEL 4.1): versao prova instalacao, nunca autenticacao.
    const health = await probeLocalAgent(spec({ versionArgs: ['--version'] }), {}, withDeps())
    expect(health.installed).toBe(true)
    expect(health.version).toBe('1.2.3')
    expect(health.ready).toBe('unknown')
  })

  it('readinessProbe unsupported mantem ready unknown mesmo com readinessArgs que passa', async () => {
    const health = await probeLocalAgent(
      spec({ versionArgs: ['--version'], readinessArgs: ['--pronto'] }),
      { capabilities: CAPS('unsupported') },
      withDeps(),
    )
    expect(health.installed).toBe(true)
    expect(health.version).toBe('1.2.3')
    expect(health.ready).toBe('unknown')
    expect(health.detail).toContain('readinessProbe unsupported')
  })

  it('sem readinessArgs o ready e unknown', async () => {
    const health = await probeLocalAgent(
      spec({ versionArgs: ['--version'] }),
      { capabilities: CAPS('supported') },
      withDeps(),
    )
    expect(health.ready).toBe('unknown')
    expect(health.detail).toContain('sem readinessArgs')
  })

  it('readinessArgs que sai 0 devolve ready true', async () => {
    const health = await probeLocalAgent(
      spec({ readinessArgs: ['--pronto'] }),
      { capabilities: CAPS('supported') },
      withDeps(),
    )
    expect(health.ready).toBe(true)
  })

  it('readinessArgs que sai diferente de 0 devolve ready false', async () => {
    const health = await probeLocalAgent(
      spec({ readinessArgs: ['--nao-pronto'] }),
      { capabilities: CAPS('supported') },
      withDeps(),
    )
    expect(health.ready).toBe(false)
    expect(health.detail).toContain('codigo 4')
  })

  it('sonda de prontidao travada devolve ready unknown, nao false', async () => {
    const health = await probeLocalAgent(
      spec({ readinessArgs: ['--prontidao-lenta'] }),
      { capabilities: CAPS('supported') },
      withDeps({ probeTimeoutMs: 250 }),
    )
    expect(health.ready).toBe('unknown')
    expect(health.detail).toContain('expirou')
  })
})

describe('probeLocalAgent — ambiente (P17)', () => {
  it('nao repassa variavel fora da allowlist para o processo do probe', async () => {
    nodeProcess.env.SEGREDO_DO_TESTE = 'vazou'
    try {
      const health = await probeLocalAgent(
        spec({ readinessArgs: ['--segredo-ausente'] }),
        { capabilities: CAPS('supported') },
        withDeps(),
      )
      // a CLI de mentira sai 0 apenas quando SEGREDO_DO_TESTE nao existe no ambiente dela
      expect(health.ready).toBe(true)
    } finally {
      delete nodeProcess.env.SEGREDO_DO_TESTE
    }
  })

  it('usa exatamente o probeEnv configurado quando ele e informado', async () => {
    const health = await probeLocalAgent(
      spec({ readinessArgs: ['--segredo-ausente'] }),
      { capabilities: CAPS('supported') },
      withDeps({ probeEnv: { PATH: nodeProcess.env.PATH ?? '', SEGREDO_DO_TESTE: 'presente' } }),
    )
    expect(health.ready).toBe(false)
  })
})

describe('probeLocalAgent — contabilidade e relato', () => {
  it('repassa running e capacity vindos do chamador', async () => {
    const health = await probeLocalAgent(spec(), { running: 2, capacity: 3 }, withDeps())
    expect(health.running).toBe(2)
    expect(health.capacity).toBe(3)
  })

  it('usa o CapacityLedger quando o chamador nao informa contabilidade', async () => {
    const ledger = new CapacityLedger({ [PROVIDER]: 2 })
    ledger.acquire(PROVIDER)
    const health = await probeLocalAgent(spec(), {}, withDeps({ ledger }))
    expect(health.running).toBe(1)
    expect(health.capacity).toBe(2)
  })

  it('sem contabilidade alguma reporta running 0 e capacity null', async () => {
    const health = await probeLocalAgent(spec(), {}, withDeps())
    expect(health.running).toBe(0)
    expect(health.capacity).toBeNull()
  })

  it('detail diz como cada valor foi apurado', async () => {
    const health = await probeLocalAgent(
      spec({ versionArgs: ['--version'] }),
      { capabilities: CAPS('unsupported') },
      withDeps(),
    )
    expect(health.detail).toContain(`\`${FAKE_CLI} --version\``)
    expect(health.detail).toContain('prontidao nao observavel')
  })

  it('probedAt vem do relogio injetado', async () => {
    const instante = Date.parse('2026-08-30T10:00:00.000Z')
    const health = await probeLocalAgent(spec(), {}, withDeps({ now: () => instante }))
    expect(health.probedAt.toISOString()).toBe('2026-08-30T10:00:00.000Z')
  })
})

describe('extractVersion', () => {
  it('aceita formatos comuns e recusa saida sem numero', () => {
    expect(extractVersion('cli 2.1.4')).toBe('2.1.4')
    expect(extractVersion('v0.9.2 (2026-08-30)')).toBe('0.9.2')
    expect(extractVersion('release 3.0')).toBe('3.0')
    expect(extractVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1')
    expect(extractVersion('sem numero')).toBe('unknown')
    expect(extractVersion('', 'fallback 7.7.7')).toBe('7.7.7')
  })
})
