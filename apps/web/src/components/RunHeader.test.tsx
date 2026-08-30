import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeSnapshot } from '../__fixtures__/snapshot.js'
import { RunHeader } from './RunHeader.js'

const NOW = Date.parse('2026-01-08T12:44:00.000Z')

const noop = (): void => {}

describe('cabecalho do run', () => {
  it('mostra missao, estado e contadores por estado', () => {
    render(<RunHeader snapshot={makeSnapshot()} now={NOW} onPause={noop} onResume={noop} />)
    expect(screen.getByRole('heading', { name: 'DA-BPM-021' })).toBeTruthy()
    expect(screen.getByText('RUNNING')).toBeTruthy()
    expect(screen.getByText('17 tasks')).toBeTruthy()
    expect(screen.getByTestId('counter-DONE').textContent).toContain('8 DONE')
    expect(screen.getByTestId('counter-BLOCKED').textContent).toContain('1 BLOCKED')
    expect(screen.queryByTestId('counter-SKIPPED')).toBeNull()
  })

  it('mostra wall time corrente, tentativas, retries e paralelismo', () => {
    render(<RunHeader snapshot={makeSnapshot()} now={NOW} onPause={noop} onResume={noop} />)
    expect(screen.getByText('wall time 34m00s')).toBeTruthy()
    expect(screen.getByText('tentativas 21')).toBeTruthy()
    expect(screen.getByText('retries 4')).toBeTruthy()
    expect(screen.getByText('paralelismo 2,4×')).toBeTruthy()
  })

  it('traz o painel de providers com `unknown` visivel', () => {
    render(<RunHeader snapshot={makeSnapshot()} now={NOW} onPause={noop} onResume={noop} />)
    const providers = screen.getByRole('region', { name: 'Providers' })
    expect(providers.textContent).toContain('unknown')
  })

  it('oferece pause enquanto o run esta RUNNING', () => {
    const onPause = vi.fn()
    render(<RunHeader snapshot={makeSnapshot()} now={NOW} onPause={onPause} onResume={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /pause/ }))
    expect(onPause).toHaveBeenCalledTimes(1)
  })

  it('troca para resume quando o run esta PAUSED', () => {
    const onResume = vi.fn()
    const snapshot = makeSnapshot()
    snapshot.run.status = 'PAUSED'
    render(<RunHeader snapshot={snapshot} now={NOW} onPause={noop} onResume={onResume} />)
    expect(screen.queryByRole('button', { name: /pause/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /resume/ }))
    expect(onResume).toHaveBeenCalledTimes(1)
  })
})
