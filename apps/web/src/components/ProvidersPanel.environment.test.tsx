import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PROVIDERS, PROVIDERS_WITH_ENVIRONMENT } from '../__fixtures__/snapshot.js'
import { ProvidersPanel, unknownableTone } from './ProvidersPanel.js'

describe('prontidao observavel do provider', () => {
  it('mostra o caminho resolvido do executavel', () => {
    render(<ProvidersPanel providers={PROVIDERS_WITH_ENVIRONMENT} />)
    expect(screen.getByTestId('provider-agente-a-path').textContent).toBe('/usr/local/bin/agente-a')
  })

  it('mostra como a prontidao foi apurada — inclusive quando deu unknown', () => {
    render(<ProvidersPanel providers={PROVIDERS_WITH_ENVIRONMENT} />)
    expect(screen.getByTestId('provider-agente-a-readiness-source').textContent).toBe(
      'probe nao suportada pela CLI',
    )
    const row = screen.getByTestId('provider-agente-a')
    expect(within(row).getByText('unknown')).toBeTruthy()
  })

  it('mostra o diagnostico do ambiente com alvo e conserto', () => {
    render(<ProvidersPanel providers={PROVIDERS_WITH_ENVIRONMENT} />)
    const diagnostic = screen.getByTestId('provider-agente-b-diagnostic')
    expect(diagnostic.textContent).toContain('broken-symlink')
    expect(diagnostic.textContent).toContain('link em ~/.local/bin/agente-b')
    expect(diagnostic.textContent).toContain('alvo /opt/agente-b/bin/agente-b')
    expect(diagnostic.textContent).toContain('conserto: reinstale a CLI ou refaca o link')
  })

  it('`unknown` em resolvedPath continua `unknown` — nunca pintado de verde', () => {
    render(<ProvidersPanel providers={PROVIDERS_WITH_ENVIRONMENT} />)
    const path = screen.getByTestId('provider-agente-b-path')
    expect(path.textContent).toBe('unknown')
    expect(path.parentElement?.getAttribute('data-tone')).toBe('unknown')
    expect(path.parentElement?.getAttribute('data-tone')).not.toBe('ok')
    expect(unknownableTone('unknown')).toBe('unknown')
    expect(unknownableTone('/usr/local/bin/x')).toBe('neutral')
  })

  it('provider sem os campos novos nao ganha linha de ambiente inventada', () => {
    render(<ProvidersPanel providers={PROVIDERS} />)
    expect(screen.queryByTestId('provider-agente-a-env')).toBeNull()
    expect(screen.queryByTestId('provider-mock-env')).toBeNull()
  })

  it('no cabecalho compacto so o diagnostico aparece — o resto fica no painel completo', () => {
    render(<ProvidersPanel providers={PROVIDERS_WITH_ENVIRONMENT} compact />)
    expect(screen.getByTestId('provider-agente-b-diagnostic').textContent).toContain(
      'broken-symlink',
    )
    expect(screen.queryByTestId('provider-agente-b-path')).toBeNull()
    expect(screen.queryByTestId('provider-agente-a-env')).toBeNull()
  })

  it('a linha de ambiente nao desloca as colunas de installed e ready', () => {
    render(<ProvidersPanel providers={PROVIDERS_WITH_ENVIRONMENT} />)
    const row = screen.getByTestId('provider-agente-b')
    const cells = row.querySelectorAll('td')
    expect(cells[0]?.textContent).toBe('não')
    expect(cells[1]?.textContent).toBe('não')
    expect(cells[2]?.textContent).toBe('unknown')
  })
})
