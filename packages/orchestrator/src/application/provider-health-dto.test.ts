import type { ProviderHealth, ProviderId } from '@agentic/domain'
import { ProviderHealthDtoSchema } from '@agentic/schemas'
import { describe, expect, it } from 'vitest'
import { toProviderHealthDto } from './snapshot.js'

/**
 * Regressao de um defeito real: os campos de diagnostico acrescentados a porta em T203
 * eram descartados nesta travessia, entao o doctor e o dashboard nunca os veriam.
 */
const base = (extra: Partial<ProviderHealth> = {}): ProviderHealth => ({
  providerId: 'exemplo-cli' as ProviderId,
  installed: true,
  ready: 'unknown',
  version: '1.2.3',
  detail: 'apurado por sonda',
  running: 0,
  capacity: 2,
  probedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...extra,
})

describe('toProviderHealthDto', () => {
  it('leva caminho resolvido, origem da prontidao e diagnostico ate o DTO', () => {
    const dto = toProviderHealthDto(
      base({
        resolvedPath: '/opt/bin/exemplo',
        readinessSource: 'sonda auth status saiu 0',
        diagnostic: {
          kind: 'broken-symlink',
          detail: 'link aponta para alvo inexistente',
          target: '/nao/existe/exemplo',
          remediation: 'reaponte o link para uma instalacao valida',
        },
      }),
    )

    expect(dto.resolvedPath).toBe('/opt/bin/exemplo')
    expect(dto.readinessSource).toBe('sonda auth status saiu 0')
    expect(dto.diagnostic?.kind).toBe('broken-symlink')
    expect(dto.diagnostic?.target).toBe('/nao/existe/exemplo')
    expect(dto.diagnostic?.remediation).toContain('reaponte')
  })

  it('omite os campos opcionais quando a porta nao os apurou', () => {
    const dto = toProviderHealthDto(base())
    expect('resolvedPath' in dto).toBe(false)
    expect('readinessSource' in dto).toBe(false)
    expect('diagnostic' in dto).toBe(false)
  })

  it('preserva unknown como unknown, nunca como booleano', () => {
    const dto = toProviderHealthDto(base({ installed: 'unknown', ready: 'unknown' }))
    expect(dto.installed).toBe('unknown')
    expect(dto.ready).toBe('unknown')
  })

  it('o DTO produzido satisfaz o schema publicado', () => {
    const dto = toProviderHealthDto(
      base({ resolvedPath: '/opt/bin/exemplo', readinessSource: 'sonda saiu 0' }),
    )
    expect(() => ProviderHealthDtoSchema.parse(dto)).not.toThrow()
  })
})
