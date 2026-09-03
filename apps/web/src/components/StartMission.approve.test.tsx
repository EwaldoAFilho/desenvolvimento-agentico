import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeCompileReport, PROVIDERS } from '../__fixtures__/snapshot.js'
import { StartMission } from './StartMission.js'

/** O ato unico e do humano; as duas chamadas sao de quem controla o run. */
function setup(kind: 'clean' | 'warning' | 'error' = 'clean', approved = false, withOneAct = true) {
  const onApprove = vi.fn()
  const onStart = vi.fn()
  const onApproveAndStart = vi.fn()
  render(
    <StartMission
      report={makeCompileReport(kind)}
      approved={approved}
      providers={PROVIDERS}
      onApprove={onApprove}
      onStart={onStart}
      {...(withOneAct ? { onApproveAndStart } : {})}
    />,
  )
  return { onApprove, onStart, onApproveAndStart }
}

function typeActor(value = 'ewaldo'): void {
  fireEvent.change(screen.getByLabelText(/actor/i), { target: { value } })
}

function typeNote(value: string): void {
  fireEvent.change(screen.getByLabelText(/nota da aprovação/i), { target: { value } })
}

function oneAct(): HTMLElement {
  return screen.getByTestId('approve-and-start')
}

describe('aprovar e executar num ato so', () => {
  it('exige quem aprova: sem actor nao ha ato', () => {
    const { onApproveAndStart } = setup()
    expect(oneAct().hasAttribute('disabled')).toBe(true)
    fireEvent.click(oneAct())
    expect(onApproveAndStart).not.toHaveBeenCalled()
  })

  it('um clique leva actor e nota — e nao dispara aprovacao nem partida por fora', () => {
    const { onApprove, onStart, onApproveAndStart } = setup()
    typeActor('ewaldo')
    typeNote('plano revisado nó a nó')
    fireEvent.click(oneAct())

    expect(onApproveAndStart).toHaveBeenCalledWith(false, 'ewaldo', 'plano revisado nó a nó')
    // As duas chamadas sao do controlador, em ordem: a tela nao aprova por um caminho e
    // parte por outro.
    expect(onApprove).not.toHaveBeenCalled()
    expect(onStart).not.toHaveBeenCalled()
  })

  it('clique duplo no ato unico cria um run so', () => {
    const { onApproveAndStart } = setup()
    typeActor()
    const button = oneAct()
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onApproveAndStart).toHaveBeenCalledTimes(1)
    expect(button.getAttribute('data-phase')).toBe('starting')
    expect(button.hasAttribute('disabled')).toBe(true)
  })

  it('com aviso pendente, o ato unico tambem passa pela confirmacao explicita', () => {
    const { onApproveAndStart } = setup('warning')
    typeActor()
    fireEvent.click(oneAct())
    expect(onApproveAndStart).not.toHaveBeenCalled()

    // Os avisos continuam a vista, e a confirmacao diz o que ela registra.
    expect(screen.getByTestId('diagnostics-warning')).toBeTruthy()
    expect(screen.getByTestId('confirm-approve-start').textContent).toContain('ewaldo')

    const confirm = screen.getByTestId('confirm-start')
    expect(confirm.getAttribute('data-act')).toBe('approve-start')
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(onApproveAndStart).toHaveBeenCalledTimes(1)
    expect(onApproveAndStart).toHaveBeenCalledWith(true, 'ewaldo', '')
  })

  it('cancelar a confirmacao nao aprova nada', () => {
    const { onApprove, onApproveAndStart } = setup('warning')
    typeActor()
    fireEvent.click(oneAct())
    fireEvent.click(screen.getByRole('button', { name: 'cancelar' }))

    expect(onApproveAndStart).not.toHaveBeenCalled()
    expect(onApprove).not.toHaveBeenCalled()
    expect(oneAct()).toBeTruthy()
  })

  it('aprovada no meio do caminho, a confirmacao pendente vira partida — nao segunda aprovacao', () => {
    const onStart = vi.fn()
    const onApproveAndStart = vi.fn()
    const props = {
      report: makeCompileReport('warning'),
      providers: PROVIDERS,
      onApprove: vi.fn(),
      onStart,
      onApproveAndStart,
    }
    const view = render(<StartMission {...props} approved={false} />)
    typeActor()
    fireEvent.click(oneAct())

    // A aprovacao passou e a partida falhou: quem controla o run devolve `approved` e `idle`.
    view.rerender(<StartMission {...props} approved startPhase="idle" error="falha ao iniciar" />)
    fireEvent.click(screen.getByTestId('confirm-start'))

    expect(onApproveAndStart).not.toHaveBeenCalled()
    expect(onStart).toHaveBeenCalledWith(true, 'ewaldo')
    expect(screen.queryByTestId('confirm-approve-start')).toBeNull()
  })

  it('missao ja aprovada nao oferece o ato unico: resta a partida', () => {
    setup('clean', true)
    expect(screen.queryByTestId('approve-and-start')).toBeNull()
    expect(screen.getByTestId('start-mission')).toBeTruthy()
  })

  it('com ERROR nao ha ato unico nem partida', () => {
    setup('error')
    expect(screen.queryByTestId('approve-and-start')).toBeNull()
    expect(screen.queryByTestId('start-mission')).toBeNull()
  })

  it('sem o ato unico a tela continua com os dois atos separados', () => {
    const { onApprove } = setup('clean', false, false)
    typeActor()
    expect(screen.queryByTestId('approve-and-start')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'aprovar missão' }))
    expect(onApprove).toHaveBeenCalledWith('ewaldo', '')
    expect(screen.getByTestId('start-mission').hasAttribute('disabled')).toBe(true)
  })

  it('o destino do ato e anunciado em texto, nao so pelo rotulo do botao', () => {
    setup()
    expect(screen.getByTestId('start-phase').textContent).toContain('DAG vivo')
  })
})

describe('os conflitos do plano', () => {
  it('dizem QUEM se atropela com quem, e de que natureza', () => {
    setup('warning')
    const conflicts = screen.getByTestId('conflicts')
    expect(conflicts.querySelectorAll('li')).toHaveLength(1)
    expect(conflicts.textContent).toContain('T07 ↔ T09')
    expect(conflicts.textContent).toContain('escopo')
  })

  it('plano sem conflito escreve isso: silencio seria indistinguivel de ninguem ter olhado', () => {
    setup('clean')
    expect(screen.getByTestId('conflicts-empty').textContent).toContain('nenhum conflito')
    expect(screen.queryByTestId('conflicts')).toBeNull()
  })

  it('a linha de numeros traz paralelismo e a contagem de conflitos', () => {
    setup('warning')
    const stats = screen.getByTestId('mission-stats').textContent ?? ''
    expect(stats).toContain('paralelismo máximo 4')
    expect(stats).toContain('1 conflitos')
    expect(stats).toContain('caminho crítico 8 tasks')
  })
})
