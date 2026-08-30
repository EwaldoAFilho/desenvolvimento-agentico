import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import type { ProviderHealth } from '@agentic/domain'
import { createProviderRegistryFromProject } from '@agentic/providers'
import { parseProjectFile } from '@agentic/schemas'
import { beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_ROOT, PROJECT_PATH } from './support/fixture.js'

/**
 * SONDA opt-in contra as CLIs REAIS declaradas no fixture. Desligada por padrao: sem
 * `AGENTIC_SMOKE_REAL`, `npm run test:e2e` nunca executa nada daqui.
 *
 * Mesmo LIGADA ela nao despacha agente e nao envia prompt: so pergunta instalacao, versao e
 * prontidao — o mesmo que `agentic doctor` faz. Nenhuma quota e consumida em nenhum caminho.
 * A execucao de uma missao real com agentes de verdade e procedimento MANUAL, descrito em
 * docs/missions/SMOKE-REAL.md.
 */

const LIGADO = nodeProcess.env.AGENTIC_SMOKE_REAL !== undefined

function linha(health: ProviderHealth): string {
  return `${health.providerId}: installed=${String(health.installed)} ready=${String(health.ready)} versao=${health.version} — ${health.detail}`
}

describe.skipIf(!LIGADO)('prontidao observada das CLIs reais (opt-in)', () => {
  let saude: ProviderHealth[] = []
  let capacidades: Readonly<Record<string, number>> = {}

  beforeAll(async () => {
    const text = await readFile(join(FIXTURE_ROOT, PROJECT_PATH), 'utf8')
    const parsed = parseProjectFile(text)
    if (!parsed.ok)
      throw new Error(`project.yaml do fixture invalido: ${JSON.stringify(parsed.issues)}`)
    capacidades = Object.fromEntries(
      Object.entries(parsed.value.providers.registry).map(([id, config]) => [
        id,
        config.maxConcurrent,
      ]),
    )
    // Registry REAL: nenhum factory substituto. `health()` roda `--version` e a sonda de
    // login de cada CLI — processos locais, sem prompt e sem modelo.
    const registry = createProviderRegistryFromProject(parsed.value)
    saude = await registry.health()
    for (const item of saude) console.info(linha(item))
  }, 120_000)

  it('sonda todos os fornecedores declarados sem lancar', () => {
    expect(saude.map((item) => String(item.providerId))).toEqual(['claude-code', 'codex'])
  })

  it('nunca declara pronto o que nao foi observado', () => {
    for (const item of saude) {
      expect([true, false, 'unknown'], linha(item)).toContain(item.installed)
      expect([true, false, 'unknown'], linha(item)).toContain(item.ready)
      // CLI ausente jamais aparece pronta, e versao nao apurada continua `unknown`.
      if (item.installed === false) {
        expect(item.ready, linha(item)).toBe(false)
        expect(item.version, linha(item)).toBe('unknown')
      }
      expect(item.probedAt.getTime()).toBeLessThanOrEqual(Date.now())
    }
  })

  it('reporta a capacidade declarada no project.yaml do fixture', () => {
    for (const item of saude) {
      expect(item.capacity, linha(item)).toBe(capacidades[String(item.providerId)])
      expect(item.running, linha(item)).toBe(0)
    }
  })

  it('encontra ao menos um fornecedor pronto — senao nao ha smoke real a fazer', () => {
    const prontos = saude.filter((item) => item.installed === true && item.ready !== false)
    expect(prontos.map(linha).join(' | ')).not.toBe('')
  })
})
