import type { ProviderHealthDto, Tristate } from '@agentic/schemas'
import type { JSX } from 'react'

/**
 * `unknown` e resposta legitima: nem toda CLI permite observar autenticacao de forma
 * confiavel. A UI mostra `unknown` como `unknown` — nunca pinta de verde por otimismo
 * (DASHBOARD 5.1).
 */
export function tristateText(value: Tristate): string {
  if (value === 'unknown') return 'unknown'
  return value ? 'sim' : 'não'
}

export function tristateTone(value: Tristate): 'ok' | 'bad' | 'unknown' {
  if (value === 'unknown') return 'unknown'
  return value ? 'ok' : 'bad'
}

function slots(provider: ProviderHealthDto): string {
  const capacity = provider.capacity
  if (capacity === null) return `${provider.running} em execução`
  return `${provider.running}/${capacity}`
}

function dots(provider: ProviderHealthDto): string {
  const capacity = provider.capacity
  if (capacity === null) return ''
  const filled = Math.min(provider.running, capacity)
  return '●'.repeat(filled) + '○'.repeat(Math.max(0, capacity - filled))
}

export interface ProvidersPanelProps {
  readonly providers: readonly ProviderHealthDto[]
  readonly compact?: boolean
}

export function ProvidersPanel({ providers, compact = false }: ProvidersPanelProps): JSX.Element {
  return (
    <section className={`providers${compact ? ' providers--compact' : ''}`} aria-label="Providers">
      <table className="providers__table">
        <caption className="sr-only">Saúde e capacidade dos providers</caption>
        <thead>
          <tr>
            <th scope="col">provider</th>
            <th scope="col">installed</th>
            <th scope="col">ready</th>
            <th scope="col">version</th>
            <th scope="col">running/capacity</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => (
            <tr key={provider.providerId} data-testid={`provider-${provider.providerId}`}>
              <th scope="row" className="providers__id">
                {provider.providerId}
              </th>
              <td data-tone={tristateTone(provider.installed)}>
                <span className="providers__flag">{tristateText(provider.installed)}</span>
              </td>
              <td data-tone={tristateTone(provider.ready)}>
                <span className="providers__flag">{tristateText(provider.ready)}</span>
              </td>
              <td className="providers__version">{provider.version}</td>
              <td className="providers__slots">
                <span className="providers__dots" aria-hidden="true">
                  {dots(provider)}
                </span>
                <span>{slots(provider)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
