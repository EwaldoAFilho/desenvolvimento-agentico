import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeCompileReport, PROVIDERS } from '../__fixtures__/snapshot.js'
import { StartMission, type StartPhase } from './StartMission.js'

function setup(
  kind: 'clean' | 'warning' = 'clean',
  startPhase?: StartPhase,
  error?: string,
): ReturnType<typeof vi.fn> {
  const onStart = vi.fn()
  render(
    <StartMission
      report={makeCompileReport(kind)}
      approved
      providers={PROVIDERS}
      startPhase={startPhase}
      error={error}
      onApprove={vi.fn()}
      onStart={onStart}
    />,
  )
  fireEvent.change(screen.getByLabelText(/actor/i), { target: { value: 'ewaldo' } })
  return onStart
}

function startButton(): HTMLElement {
  return screen.getByTestId('start-mission')
}

describe('START MISSION sem duplo envio', () => {
  it('clique duplo cria um run so', () => {
    const onStart = setup('clean')
    const button = startButton()
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStart).toHaveBeenCalledWith(false, 'ewaldo')
  })

  it('o botao passa de Start para Starting… e fica desabilitado', () => {
    setup('clean')
    expect(startButton().textContent).toBe('START MISSION')
    expect(startButton().getAttribute('data-phase')).toBe('idle')
    fireEvent.click(startButton())
    expect(startButton().textContent).toBe('iniciando…')
    expect(startButton().getAttribute('data-phase')).toBe('starting')
    expect(startButton().hasAttribute('disabled')).toBe(true)
    expect(startButton().getAttribute('aria-busy')).toBe('true')
  })

  it('com run em andamento o botao diz Running e nao dispara nada', () => {
    const onStart = setup('clean', 'running')
    expect(startButton().textContent).toBe('run em andamento')
    fireEvent.click(startButton())
    expect(onStart).not.toHaveBeenCalled()
  })

  it('a fase informada por quem conhece o run tambem bloqueia o clique', () => {
    const onStart = setup('clean', 'starting')
    fireEvent.click(startButton())
    expect(onStart).not.toHaveBeenCalled()
    expect(startButton().textContent).toBe('iniciando…')
  })

  it('com aviso, o duplo clique no confirmar tambem cria um run so', () => {
    const onStart = setup('warning')
    fireEvent.click(startButton())
    const confirm = screen.getByTestId('confirm-start')
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStart).toHaveBeenCalledWith(true, 'ewaldo')
  })

  it('abrir a confirmacao nao conta como partida', () => {
    const onStart = setup('warning')
    fireEvent.click(startButton())
    expect(onStart).not.toHaveBeenCalled()
    expect(screen.getByTestId('confirm-start').getAttribute('data-phase')).toBe('idle')
  })

  it('partida que falhou destrava o botao para nova tentativa', () => {
    const onStart = setup('clean', undefined, 'falha ao criar o run')
    expect(startButton().hasAttribute('disabled')).toBe(false)
    fireEvent.click(startButton())
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toContain('falha ao criar o run')
  })

  it('quando o controlador devolve a fase para idle, o botao destrava de novo', () => {
    const onStart = vi.fn()
    const props = {
      report: makeCompileReport('clean'),
      approved: true,
      providers: PROVIDERS,
      onApprove: vi.fn(),
      onStart,
    }
    const view = render(<StartMission {...props} startPhase="idle" />)
    fireEvent.change(screen.getByLabelText(/actor/i), { target: { value: 'ewaldo' } })
    fireEvent.click(startButton())
    expect(onStart).toHaveBeenCalledTimes(1)

    view.rerender(<StartMission {...props} startPhase="starting" />)
    fireEvent.click(startButton())
    expect(onStart).toHaveBeenCalledTimes(1)

    // A partida falhou e o controlador devolveu `idle`: uma nova tentativa e possivel.
    view.rerender(<StartMission {...props} startPhase="idle" />)
    expect(startButton().hasAttribute('disabled')).toBe(false)
    fireEvent.click(startButton())
    expect(onStart).toHaveBeenCalledTimes(2)
  })

  it('o estado da partida e anunciado em texto, nao so por cor', () => {
    setup('clean')
    expect(screen.getByTestId('start-phase').textContent).toBe('pronta para partir')
    fireEvent.click(startButton())
    expect(screen.getByTestId('start-phase').textContent).toContain('iniciando o run')
    expect(screen.getByTestId('start-phase').getAttribute('role')).toBe('status')
  })

  it('busy do controlador tambem impede um segundo envio', () => {
    const onStart = vi.fn()
    const view = render(
      <StartMission
        report={makeCompileReport('clean')}
        approved
        providers={PROVIDERS}
        busy
        onApprove={vi.fn()}
        onStart={onStart}
      />,
    )
    fireEvent.change(screen.getByLabelText(/actor/i), { target: { value: 'ewaldo' } })
    fireEvent.click(screen.getByTestId('start-mission'))
    expect(onStart).not.toHaveBeenCalled()
    view.unmount()
  })
})
