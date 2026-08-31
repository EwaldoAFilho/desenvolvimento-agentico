import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PROVIDERS } from '../__fixtures__/snapshot.js'
import { ProvidersPanel, tristateText, tristateTone } from './ProvidersPanel.js'

describe('painel de providers', () => {
  it('exibe `unknown` literalmente — nunca "sim" nem verde', () => {
    render(<ProvidersPanel providers={PROVIDERS} />)
    const row = screen.getByTestId('provider-agente-a')
    expect(within(row).getByText('unknown')).toBeTruthy()
    const readyCell = row.querySelectorAll('td')[1]
    expect(readyCell?.textContent).toBe('unknown')
    expect(readyCell?.getAttribute('data-tone')).toBe('unknown')
    expect(readyCell?.getAttribute('data-tone')).not.toBe('ok')
  })

  it('`unknown` nao e tratado como verdadeiro em nenhum lugar', () => {
    expect(tristateText('unknown')).toBe('unknown')
    expect(tristateTone('unknown')).toBe('unknown')
    expect(tristateTone(true)).toBe('ok')
    expect(tristateTone(false)).toBe('bad')
  })

  it('mostra installed, version e running/capacity de cada provider', () => {
    render(<ProvidersPanel providers={PROVIDERS} />)
    const row = screen.getByTestId('provider-agente-a')
    expect(within(row).getByText('2.1.4')).toBeTruthy()
    expect(within(row).getByText('2/3')).toBeTruthy()
    expect(screen.getByTestId('provider-mock')).toBeTruthy()
    expect(within(screen.getByTestId('provider-mock')).getByText('0/8')).toBeTruthy()
  })

  it('capacidade nula e descrita em texto, sem inventar limite', () => {
    render(
      <ProvidersPanel
        providers={[
          {
            providerId: 'sem-limite',
            installed: 'unknown',
            ready: 'unknown',
            version: '—',
            detail: '',
            running: 4,
            capacity: null,
          },
        ]}
      />,
    )
    expect(screen.getByText('4 em execução')).toBeTruthy()
    const row = screen.getByTestId('provider-sem-limite')
    expect(within(row).getAllByText('unknown')).toHaveLength(2)
  })
})

describe('razao da prontidao', () => {
  it('o painel completo explica por que a prontidao deu `unknown`', () => {
    render(<ProvidersPanel providers={PROVIDERS} />)
    expect(screen.getByTestId('provider-agente-a-reason').textContent).toBe(
      'CLI nao expoe estado de autenticacao',
    )
  })

  it('provider sem razao apurada nao ganha texto inventado', () => {
    render(
      <ProvidersPanel
        providers={[
          {
            providerId: 'sem-razao',
            installed: 'unknown',
            ready: 'unknown',
            version: 'unknown',
            detail: '',
            running: 0,
            capacity: 1,
          },
        ]}
      />,
    )
    expect(screen.getByTestId('provider-sem-razao-reason').textContent).toBe('—')
  })

  it('no cabecalho compacto a razao nao aparece — detalhe excessivo mora no painel', () => {
    render(<ProvidersPanel providers={PROVIDERS} compact />)
    expect(screen.queryByTestId('provider-agente-a-reason')).toBeNull()
  })
})
