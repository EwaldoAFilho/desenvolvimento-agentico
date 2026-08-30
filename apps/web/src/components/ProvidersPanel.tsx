import type { ProviderDiagnosticDto, ProviderHealthDto, Tristate } from '@agentic/schemas'
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

/** `resolvedPath` tambem pode ser o literal `unknown`: nao vira caminho nem vira verde. */
export function unknownableTone(value: string | undefined): 'neutral' | 'unknown' {
  return value === 'unknown' ? 'unknown' : 'neutral'
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

/**
 * No cabecalho o espaco e caro: la so o diagnostico aparece, porque e o que exige acao.
 * Caminho resolvido e origem da prontidao ficam no painel completo.
 */
function hasEnvironment(provider: ProviderHealthDto, compact: boolean): boolean {
  if (compact) return provider.diagnostic !== undefined
  return (
    provider.resolvedPath !== undefined ||
    provider.readinessSource !== undefined ||
    provider.diagnostic !== undefined
  )
}

function DiagnosticLine({
  diagnostic,
}: {
  readonly diagnostic: ProviderDiagnosticDto
}): JSX.Element {
  return (
    <span className="providers__diagnostic">
      <span className="providers__diagnostic-kind">{diagnostic.kind}</span>
      <span>{diagnostic.detail}</span>
      {diagnostic.target === undefined ? null : (
        <span className="providers__diagnostic-target">{`alvo ${diagnostic.target}`}</span>
      )}
      {diagnostic.remediation === undefined ? null : (
        <span className="providers__diagnostic-fix">{`conserto: ${diagnostic.remediation}`}</span>
      )}
    </span>
  )
}

/**
 * Linha de ambiente: `resolvedPath`, `readinessSource` e `diagnostic`. Existe porque
 * `installed: false` sozinho nao distingue "nunca instalado" de "link apontando para uma
 * instalacao que sumiu" — e a diferenca custa horas de diagnostico.
 */
function EnvironmentRow({
  provider,
  compact,
}: {
  readonly provider: ProviderHealthDto
  readonly compact: boolean
}): JSX.Element {
  return (
    <tr className="providers__env" data-testid={`provider-${provider.providerId}-env`}>
      <td colSpan={5}>
        {compact || provider.resolvedPath === undefined ? null : (
          <span className="providers__env-item" data-tone={unknownableTone(provider.resolvedPath)}>
            <span className="providers__env-label">resolvedPath</span>
            <code data-testid={`provider-${provider.providerId}-path`}>
              {provider.resolvedPath}
            </code>
          </span>
        )}
        {compact || provider.readinessSource === undefined ? null : (
          <span className="providers__env-item">
            <span className="providers__env-label">readinessSource</span>
            <span data-testid={`provider-${provider.providerId}-readiness-source`}>
              {provider.readinessSource}
            </span>
          </span>
        )}
        {provider.diagnostic === undefined ? null : (
          <span
            className="providers__env-item providers__env-item--bad"
            data-testid={`provider-${provider.providerId}-diagnostic`}
          >
            <span className="providers__env-label">diagnostic</span>
            <DiagnosticLine diagnostic={provider.diagnostic} />
          </span>
        )}
      </td>
    </tr>
  )
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
        {providers.map((provider) => (
          <tbody key={provider.providerId}>
            <tr data-testid={`provider-${provider.providerId}`}>
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
            {hasEnvironment(provider, compact) ? (
              <EnvironmentRow provider={provider} compact={compact} />
            ) : null}
          </tbody>
        ))}
      </table>
    </section>
  )
}
