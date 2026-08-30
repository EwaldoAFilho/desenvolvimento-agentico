import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeTaskDetail } from '../__fixtures__/snapshot.js'
import { TaskDetailPanel } from './TaskDetailPanel.js'

const noop = (): void => {}

function renderPanel(overrides: Partial<Parameters<typeof TaskDetailPanel>[0]> = {}) {
  return render(
    <TaskDetailPanel
      task={makeTaskDetail()}
      onClose={noop}
      onRetry={noop}
      onUnblock={noop}
      onSkip={noop}
      {...overrides}
    />,
  )
}

function group(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

describe('painel de detalhe', () => {
  it('mostra o caminho da worktree com botao de copiar', () => {
    renderPanel()
    expect(screen.getByTestId('worktree-path').textContent).toBe(
      '/home/dev/projeto/.agentic/worktrees/DA-BPM-021/T09-a2',
    )
    expect(
      screen.getByRole('button', {
        name: 'copiar caminho: /home/dev/projeto/.agentic/worktrees/DA-BPM-021/T09-a2',
      }),
    ).toBeTruthy()
  })

  it('mostra branch e commits do isolamento', () => {
    renderPanel()
    expect(screen.getByTestId('branch').textContent).toBe('agentic/DA-BPM-021/T09')
    const isolation = group('Isolamento')
    expect(within(isolation).getByText('a1b2c3d4e5f6')).toBeTruthy()
    expect(within(isolation).getByText('git-worktree')).toBeTruthy()
  })

  it('mostra provider e executor da execucao', () => {
    renderPanel()
    const execution = group('Execução')
    expect(within(execution).getByText('agente-a')).toBeTruthy()
    expect(within(execution).getByText('frontend-executor · agente-a · modelo-grande')).toBeTruthy()
    expect(within(execution).getByText('2 de 3')).toBeTruthy()
  })

  it('mostra o revisor, o provider do revisor e a politica aplicada', () => {
    renderPanel()
    const review = group('Revisão')
    expect(within(review).getByText('revisor-independente')).toBeTruthy()
    expect(within(review).getByText('agente-b')).toBeTruthy()
    expect(screen.getByTestId('review-policy').textContent).toBe('cross-provider-required')
    expect(within(review).getByText('não — satisfeita')).toBeTruthy()
    expect(within(review).getByText(/403 ausente para usuario sem permissao/)).toBeTruthy()
  })

  it('diz explicitamente quando a politica de revisao foi rebaixada', () => {
    const task = makeTaskDetail()
    renderPanel({ task: { ...task, review: { ...task.review, policyOutcome: 'downgraded' } } })
    expect(within(group('Revisão')).getByText('sim — rebaixada')).toBeTruthy()
  })

  it('mostra grafo, escopo, qualidade e fatos', () => {
    renderPanel()
    expect(within(group('Grafo')).getByText(/T05 DONE/)).toBeTruthy()
    expect(within(group('Grafo')).getByText('T11')).toBeTruthy()
    expect(within(group('Escopo')).getByText('ui/propriedades/')).toBeTruthy()
    expect(within(group('Qualidade')).getByText('npm test -w ui')).toBeTruthy()
    expect(within(group('Qualidade')).getByText(/exit 1/)).toBeTruthy()
    expect(within(group('Fatos')).getByText('2 arquivos · +204 −12')).toBeTruthy()
    expect(within(group('Fatos')).getByText(/sha256:abc123/)).toBeTruthy()
  })

  it('mostra falha, tentativas e eventos da task', () => {
    renderPanel()
    expect(within(group('Falha')).getByText(/REVIEW_FAILED/)).toBeTruthy()
    expect(within(group('Tentativas')).getByText(/TENTATIVA 1/)).toBeTruthy()
    expect(within(group('Tentativas')).getByText(/TENTATIVA 2/)).toBeTruthy()
    expect(within(group('Eventos')).getByText('attempt.started')).toBeTruthy()
  })

  it('sem task selecionada, convida a escolher uma no canvas', () => {
    render(
      <TaskDetailPanel
        task={undefined}
        onClose={noop}
        onRetry={noop}
        onUnblock={noop}
        onSkip={noop}
      />,
    )
    expect(screen.getByText('selecione uma task no canvas')).toBeTruthy()
  })
})

describe('acoes de task', () => {
  it('retry dispara direto', () => {
    const onRetry = vi.fn()
    renderPanel({ onRetry })
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(onRetry).toHaveBeenCalledWith('T09')
  })

  it('unblock exige nota', () => {
    const onUnblock = vi.fn()
    renderPanel({ onUnblock })
    const button = screen.getByRole('button', { name: 'unblock' })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText(/nota do unblock/), {
      target: { value: 'contrato decidido na ADR-0009' },
    })
    fireEvent.click(button)
    expect(onUnblock).toHaveBeenCalledWith('T09', 'contrato decidido na ADR-0009')
  })

  it('skip exige motivo', () => {
    const onSkip = vi.fn()
    renderPanel({ onSkip })
    const button = screen.getByRole('button', { name: 'skip' })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText(/motivo do skip/), {
      target: { value: 'fora do MVP' },
    })
    fireEvent.click(button)
    expect(onSkip).toHaveBeenCalledWith('T09', 'fora do MVP')
  })

  it('nao oferece editor de missao — so as acoes do MVP', () => {
    renderPanel()
    const names = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent)
    expect(names).toEqual(expect.arrayContaining(['retry', 'unblock', 'skip', 'fechar detalhe']))
    expect(names.some((name) => /editar|criar task|nova task/i.test(name ?? ''))).toBe(false)
  })
})
