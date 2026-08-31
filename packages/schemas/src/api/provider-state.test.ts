import { describe, expect, it } from 'vitest'
import {
  PROVIDER_STATES,
  type ProviderHealthDto,
  type ProviderState,
  ProviderStateSchema,
  providerStateOf,
} from './provider-health.js'

function dto(partial: Partial<ProviderHealthDto>): ProviderHealthDto {
  return {
    providerId: 'agente-a',
    installed: 'unknown',
    ready: 'unknown',
    version: 'unknown',
    detail: '',
    running: 0,
    capacity: 2,
    ...partial,
  }
}

describe('os cinco estados de provider, agora no contrato', () => {
  it('READY: instalado e sonda de sessao aprovou', () => {
    expect(providerStateOf(dto({ installed: true, ready: true }))).toBe('READY')
  })

  it('NOT_READY: instalado, mas a sonda reprovou', () => {
    expect(providerStateOf(dto({ installed: true, ready: false }))).toBe('NOT_READY')
  })

  it('INSTALLED: instalado com prontidao NAO apurada — nunca confundido com READY', () => {
    expect(providerStateOf(dto({ installed: true, ready: 'unknown' }))).toBe('INSTALLED')
  })

  it('NOT_INSTALLED: sem executavel', () => {
    expect(providerStateOf(dto({ installed: false, ready: false }))).toBe('NOT_INSTALLED')
  })

  it('UNKNOWN: nem a instalacao foi apurada', () => {
    expect(providerStateOf(dto({ installed: 'unknown', ready: 'unknown' }))).toBe('UNKNOWN')
  })

  it('NOT_INSTALLED ganha de tudo: sem binario nao ha prontidao a discutir', () => {
    expect(providerStateOf(dto({ installed: false, ready: true }))).toBe('NOT_INSTALLED')
  })

  it('os cinco sao alcancaveis e distintos: nenhuma combinacao cai em dois', () => {
    const combos: ProviderHealthDto[] = [
      dto({ installed: true, ready: true }),
      dto({ installed: true, ready: false }),
      dto({ installed: true, ready: 'unknown' }),
      dto({ installed: false, ready: false }),
      dto({ installed: 'unknown', ready: 'unknown' }),
    ]
    const states = combos.map(providerStateOf)

    expect(new Set(states).size).toBe(PROVIDER_STATES.length)
    for (const state of states) expect(PROVIDER_STATES).toContain(state as ProviderState)
  })

  it('estado indeterminado nunca vira READY — a UI nao pinta de verde por otimismo', () => {
    const indeterminados = [
      dto({ installed: 'unknown', ready: 'unknown' }),
      dto({ installed: true, ready: 'unknown' }),
    ]

    for (const health of indeterminados) expect(providerStateOf(health)).not.toBe('READY')
  })

  it('o estado viaja no JSON como enum fechado', () => {
    expect(ProviderStateSchema.safeParse('READY').success).toBe(true)
    expect(ProviderStateSchema.safeParse('QUASE').success).toBe(false)
  })
})
