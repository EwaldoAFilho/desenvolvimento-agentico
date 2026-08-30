import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeCompileReport, PROVIDERS } from '../__fixtures__/snapshot.js'
import { StartMission } from './StartMission.js'

function setup(
  kind: 'clean' | 'warning' | 'error',
  approved: boolean,
): { onStart: ReturnType<typeof vi.fn>; onApprove: ReturnType<typeof vi.fn> } {
  const onStart = vi.fn()
  const onApprove = vi.fn()
  render(
    <StartMission
      report={makeCompileReport(kind)}
      approved={approved}
      providers={PROVIDERS}
      onApprove={onApprove}
      onStart={onStart}
    />,
  )
  return { onStart, onApprove }
}

function typeActor(value = 'ewaldo'): void {
  fireEvent.change(screen.getByLabelText(/actor/i), { target: { value } })
}

describe('START MISSION', () => {
  it('sem APPROVED o botao existe mas fica bloqueado', () => {
    setup('clean', false)
    typeActor()
    const button = screen.getByRole('button', { name: 'START MISSION' })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('START MISSION exige missão APPROVED.')).toBeTruthy()
  })

  it('com APPROVED e sem aviso, um clique inicia sem confirmacao', () => {
    const { onStart } = setup('clean', true)
    typeActor()
    fireEvent.click(screen.getByRole('button', { name: 'START MISSION' }))
    expect(onStart).toHaveBeenCalledWith(false, 'ewaldo')
  })

  it('exige actor: sem quem aprova/inicia, nao ha partida', () => {
    setup('clean', true)
    expect(screen.getByRole('button', { name: 'START MISSION' }).hasAttribute('disabled')).toBe(
      true,
    )
  })

  it('com WARNING exige confirmacao explicita, com os avisos a vista', () => {
    const { onStart } = setup('warning', true)
    typeActor()

    fireEvent.click(screen.getByRole('button', { name: 'START MISSION' }))
    expect(onStart).not.toHaveBeenCalled()

    expect(screen.getByTestId('diagnostics-warning')).toBeTruthy()
    expect(screen.getByText(/DA2001/)).toBeTruthy()
    expect(screen.getByText(/DA2007/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'confirmar partida com 2 aviso(s)' }))
    expect(onStart).toHaveBeenCalledWith(true, 'ewaldo')
  })

  it('com ERROR nao renderiza botao de partida e lista os erros', () => {
    const { onStart } = setup('error', true)
    expect(screen.queryByRole('button', { name: 'START MISSION' })).toBeNull()
    const errors = screen.getByTestId('diagnostics-error')
    expect(errors.querySelectorAll('li')).toHaveLength(2)
    expect(screen.getByText(/DA1004/)).toBeTruthy()
    expect(screen.getByText(/ciclo de dependencia entre T05 e T09/)).toBeTruthy()
    expect(onStart).not.toHaveBeenCalled()
  })

  it('aprovar e ato humano com actor registrado', () => {
    const { onApprove } = setup('warning', false)
    const approve = screen.getByRole('button', { name: 'aprovar missão' })
    expect(approve.hasAttribute('disabled')).toBe(true)
    typeActor('ewaldo')
    fireEvent.click(approve)
    expect(onApprove).toHaveBeenCalledWith('ewaldo', '')
  })

  it('com ERROR nem aprovar e oferecido', () => {
    setup('error', false)
    typeActor()
    expect(screen.getByRole('button', { name: 'aprovar missão' }).hasAttribute('disabled')).toBe(
      true,
    )
  })

  it('mostra as estatisticas da missao compilada', () => {
    setup('warning', true)
    expect(screen.getByText(/17 tasks · 7 fases/)).toBeTruthy()
    expect(screen.getByText(/2 avisos/)).toBeTruthy()
  })

  it('avisa antes da partida se algum provider estiver indisponivel', () => {
    render(
      <StartMission
        report={makeCompileReport('clean')}
        approved
        providers={[
          {
            providerId: 'agente-a',
            installed: true,
            ready: false,
            version: '2.1.4',
            detail: 'sessão expirada',
            running: 0,
            capacity: 3,
          },
        ]}
        onApprove={vi.fn()}
        onStart={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('provider indisponível: agente-a')
  })

  it('provider com ready unknown nao conta como indisponivel', () => {
    setup('clean', true)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
