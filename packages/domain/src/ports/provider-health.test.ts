import { describe, expect, it } from 'vitest'
import { providerId } from '../ids.js'
import type {
  ProviderDiagnostic,
  ProviderDiagnosticKind,
  ProviderHealth,
} from './agent-provider.js'
import { PROVIDER_DIAGNOSTIC_KINDS } from './agent-provider.js'

const PROBED_AT = new Date('2026-08-30T10:00:00.000Z')

/** Forma minima do contrato: o que existia antes de a prontidao virar observavel. */
const minimo: ProviderHealth = {
  providerId: providerId('agente-a'),
  installed: true,
  ready: 'unknown',
  version: '1.2.3',
  detail: 'CLI nao expoe estado de autenticacao',
  probedAt: PROBED_AT,
  running: 2,
  capacity: 3,
}

describe('ProviderDiagnosticKind', () => {
  it('o catalogo tem exatamente os quatro tipos declarados, sem repeticao', () => {
    expect(PROVIDER_DIAGNOSTIC_KINDS).toHaveLength(4)
    expect(new Set(PROVIDER_DIAGNOSTIC_KINDS).size).toBe(4)
  })

  it('cobre o link quebrado, a ausencia, o arquivo inerte e a sonda ilegivel', () => {
    expect([...PROVIDER_DIAGNOSTIC_KINDS]).toEqual([
      'broken-symlink',
      'not-found',
      'not-executable',
      'probe-failed',
    ])
  })

  it.each(PROVIDER_DIAGNOSTIC_KINDS)('%s e um kind valido de diagnostico', (kind) => {
    const diagnostic: ProviderDiagnostic = { kind, detail: 'motivo apurado' }
    const tipado: ProviderDiagnosticKind = diagnostic.kind
    expect(tipado).toBe(kind)
  })
})

describe('ProviderHealth — campos novos sao aditivos', () => {
  it('a forma anterior continua valida sem nenhum campo novo', () => {
    expect(minimo.resolvedPath).toBeUndefined()
    expect(minimo.readinessSource).toBeUndefined()
    expect(minimo.diagnostic).toBeUndefined()
  })

  it('unknown continua sendo valor de primeira classe em installed e ready', () => {
    const indeterminado: ProviderHealth = {
      ...minimo,
      installed: 'unknown',
      ready: 'unknown',
      version: 'unknown',
      resolvedPath: 'unknown',
      readinessSource: 'instalacao nao apurada',
    }
    expect(indeterminado.installed).toBe('unknown')
    expect(indeterminado.ready).toBe('unknown')
    expect(indeterminado.resolvedPath).toBe('unknown')
  })

  it('resolvedPath aceita caminho absoluto ou o literal unknown', () => {
    const comCaminho: ProviderHealth = { ...minimo, resolvedPath: '/usr/local/bin/agente' }
    const semCaminho: ProviderHealth = { ...minimo, resolvedPath: 'unknown' }
    expect(comCaminho.resolvedPath).toBe('/usr/local/bin/agente')
    expect(semCaminho.resolvedPath).toBe('unknown')
  })

  it('diagnostico de link quebrado carrega alvo e remediacao', () => {
    const health: ProviderHealth = {
      ...minimo,
      installed: false,
      ready: false,
      resolvedPath: 'unknown',
      readinessSource: 'prontidao false por ausencia do executavel',
      diagnostic: {
        kind: 'broken-symlink',
        detail: 'o link aponta para um alvo que nao existe',
        target: '/opt/versao-antiga/binario',
        remediation: 'recrie o link ou reinstale a CLI',
      },
    }
    expect(health.diagnostic?.kind).toBe('broken-symlink')
    expect(health.diagnostic?.target).toBe('/opt/versao-antiga/binario')
    expect(health.diagnostic?.remediation).toContain('recrie')
  })

  it('target e remediation sao opcionais: ha diagnostico sem alvo', () => {
    const health: ProviderHealth = {
      ...minimo,
      diagnostic: { kind: 'probe-failed', detail: 'a sonda expirou antes de responder' },
    }
    expect(health.diagnostic?.target).toBeUndefined()
    expect(health.diagnostic?.remediation).toBeUndefined()
  })

  it('diagnostico nao transforma prontidao indeterminada em booleano', () => {
    const health: ProviderHealth = {
      ...minimo,
      ready: 'unknown',
      diagnostic: { kind: 'probe-failed', detail: 'sonda ilegivel' },
    }
    expect(health.ready).toBe('unknown')
    expect(health.ready).not.toBe(false)
    expect(health.ready).not.toBe(true)
  })

  it('running e capacity seguem sendo contabilidade nossa, nunca unknown', () => {
    expect(Number.isInteger(minimo.running)).toBe(true)
    expect(minimo.capacity === null || Number.isInteger(minimo.capacity)).toBe(true)
  })
})
