import type { TaskDetail } from '@agentic/schemas'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  makeBlockedTaskDetail,
  makeLiveTaskDetail,
  makeNoChangesTaskDetail,
  makeScopeViolationTaskDetail,
  makeSnapshot,
  makeTaskDetail,
  withTaskStatus,
} from '../__fixtures__/snapshot.js'
import { stalledDependents, waitingReasonOf } from '../lib/waiting.js'
import { TaskDetailPanel, type TaskPanelContext } from './TaskDetailPanel.js'

const noop = (): void => {}
const NOW = Date.parse('2026-01-08T12:45:42.000Z')

function renderPanel(task: TaskDetail, context?: TaskPanelContext): void {
  render(
    <TaskDetailPanel
      task={task}
      context={{ now: NOW, ...context }}
      onClose={noop}
      onRetry={noop}
      onUnblock={noop}
      onSkip={noop}
    />,
  )
}

function group(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

function pendingContext(taskId: string): TaskPanelContext {
  const snapshot = makeSnapshot()
  return {
    now: NOW,
    waiting: waitingReasonOf(snapshot, taskId),
    stalled: stalledDependents(snapshot, taskId),
  }
}

describe('motivo de espera no painel', () => {
  it('task esperando nao diz so o estado — diz por quem espera', () => {
    const task: TaskDetail = { ...makeTaskDetail(), id: 'T11', status: 'PENDING' }
    renderPanel(task, pendingContext('T11'))
    expect(screen.getByTestId('detail-status').textContent).toContain('PENDING')
    expect(screen.getByTestId('waiting-summary').textContent).toContain('aguardando T09')
  })

  it('o grupo Espera explica o motivo, o que resolve e quem falta', () => {
    const task: TaskDetail = { ...makeTaskDetail(), id: 'T11', status: 'PENDING' }
    renderPanel(task, pendingContext('T11'))
    const espera = group('Espera')
    expect(within(espera).getByTestId('waiting-cause').textContent).toBe('aguardando T09')
    expect(within(espera).getByTestId('waiting-detail').textContent).toContain('T09 (RUNNING)')
    expect(within(espera).getByTestId('waiting-needs').textContent).toBe(
      'conclusão das dependências',
    )
    expect(within(espera).getByTestId('waiting-on').textContent).toContain('T09 RUNNING')
  })

  it('espera por revisor de outro fornecedor aparece com o que a resolve', () => {
    const task = makeBlockedTaskDetail()
    const snapshot = withTaskStatus(makeSnapshot(), 'T09', {
      status: 'BLOCKED',
      blockage: task.blockage,
    })
    renderPanel(task, {
      now: NOW,
      waiting: waitingReasonOf(snapshot, 'T09'),
      stalled: stalledDependents(snapshot, 'T09'),
    })
    expect(screen.getByTestId('waiting-cause').textContent).toBe(
      'aguardando revisor de outro fornecedor',
    )
    expect(screen.getByTestId('waiting-needs').textContent).toContain('segundo fornecedor apto')
  })

  it('task em execucao nao ganha grupo de espera', () => {
    renderPanel(makeTaskDetail())
    expect(screen.queryByRole('region', { name: 'Espera' })).toBeNull()
    expect(screen.queryByTestId('waiting-summary')).toBeNull()
  })
})

describe('UX de falha no painel', () => {
  it('NO_CHANGES mostra codigo, tentativa N/M e fornecedor — nao so FAILED', () => {
    renderPanel(makeNoChangesTaskDetail())
    const falha = group('Falha')
    expect(within(falha).getByTestId('failure-code').textContent).toContain('NO_CHANGES')
    expect(within(falha).getByTestId('failure-attempt').textContent).toBe('2 de 2')
    expect(within(falha).getByTestId('failure-provider').textContent).toBe('agente-a')
  })

  it('diz se o gate chegou a rodar', () => {
    renderPanel(makeNoChangesTaskDetail())
    expect(screen.getByTestId('failure-gate').textContent).toContain('não chegou a rodar')
  })

  it('gate que rodou aparece com o veredito e a contagem de comandos', () => {
    renderPanel(makeScopeViolationTaskDetail())
    const gate = screen.getByTestId('failure-gate').textContent ?? ''
    expect(gate).toContain('concluído')
    expect(gate).toContain('FAIL')
    expect(gate).toContain('1 comando(s)')
  })

  it('violacao de escopo aparece com os caminhos', () => {
    renderPanel(makeScopeViolationTaskDetail())
    expect(screen.getByTestId('failure-scope').textContent).toContain('packages/dominio/regra.ts')
  })

  it('sem violacao, afirma o contrario em texto', () => {
    renderPanel(makeTaskDetail())
    expect(screen.getByTestId('failure-scope').textContent).toBe(
      'não — nenhum caminho fora de touches',
    )
  })

  it('retry: diz se ainda ha tentativa disponivel', () => {
    renderPanel(makeTaskDetail())
    const retry = screen.getByTestId('failure-retry')
    expect(retry.getAttribute('data-retry')).toBe('available')
    expect(retry.textContent).toContain('restam 1 de 3')
  })

  it('retry: orcamento esgotado nao promete nova tentativa', () => {
    renderPanel(makeNoChangesTaskDetail())
    const retry = screen.getByTestId('failure-retry')
    expect(retry.getAttribute('data-retry')).toBe('exhausted')
    expect(retry.textContent).toContain('esgotado')
  })
})

describe('UX de bloqueio no painel', () => {
  it('mostra por que, o que resolve e os dependentes parados', () => {
    const task = makeBlockedTaskDetail()
    renderPanel(task, {
      now: NOW,
      stalled: stalledDependents(makeSnapshot(), task.id),
    })
    const bloqueio = group('Bloqueio')
    expect(within(bloqueio).getByTestId('blocked-reason').textContent).toContain(
      'CROSS_PROVIDER_UNAVAILABLE',
    )
    expect(within(bloqueio).getByTestId('blocked-needs').textContent).toContain(
      'segundo fornecedor apto a revisar',
    )
    const dependents = within(bloqueio).getByTestId('blocked-dependents').textContent ?? ''
    expect(dependents).toContain('T11 PENDING')
    expect(dependents).toContain('T16 PENDING (indireto)')
  })

  it('sem bloqueio nao existe grupo de bloqueio', () => {
    renderPanel(makeTaskDetail())
    expect(screen.queryByRole('region', { name: 'Bloqueio' })).toBeNull()
  })

  it('bloqueio sem ninguem atras diz nenhum, em vez de lista vazia', () => {
    renderPanel(makeBlockedTaskDetail(), { now: NOW, stalled: [] })
    expect(within(group('Bloqueio')).getByText('nenhum')).toBeTruthy()
  })
})

describe('atividade ao vivo no painel', () => {
  it('mostra o ultimo sinal medido e ha quanto tempo', () => {
    renderPanel(makeLiveTaskDetail())
    expect(screen.getByTestId('activity-last').textContent).toBe('revisão iniciada · há 30s')
  })

  it('a linha do tempo cobre agente, processo, gate e revisao', () => {
    renderPanel(makeLiveTaskDetail())
    const steps = within(group('Atividade')).getByTestId('activity-steps')
    const text = steps.textContent ?? ''
    expect(text).toContain('agente iniciado')
    expect(text).toContain('processo ativo')
    expect(text).toContain('gate iniciado')
    expect(text).toContain('gate concluído')
    expect(text).toContain('revisão iniciada')
    expect(steps.querySelectorAll('li')).toHaveLength(6)
  })

  it('cada passo cita o tipo de evento que o originou', () => {
    renderPanel(makeLiveTaskDetail())
    const sources = [...within(group('Atividade')).getByTestId('activity-steps').children].map(
      (item) => item.querySelector('.activity__source')?.textContent,
    )
    expect(sources).toContain('attempt.observed')
    expect(sources).toContain('gate.finished')
  })

  it('task encerrada nao finge processo em andamento', () => {
    renderPanel(makeNoChangesTaskDetail())
    expect(screen.getByTestId('activity-live').textContent).toBe('sem processo em andamento')
  })

  it('sem evento algum, admite que nao ha sinal medido', () => {
    renderPanel({ ...makeTaskDetail(), events: [] })
    expect(screen.getByTestId('activity-last').textContent).toBe(
      'nenhum sinal medido para esta task',
    )
  })
})

describe('log do agente', () => {
  it('oferece acesso a referencia de saida persistida, com botao de copiar', () => {
    renderPanel(makeTaskDetail())
    const refs = within(group('Log do agente')).getByTestId('log-refs')
    expect(refs.textContent).toContain('runs/01J8ZC/T09/a2/test.log')
    expect(
      screen.getByRole('button', { name: 'copiar referência: runs/01J8ZC/T09/a2/test.log' }),
    ).toBeTruthy()
  })

  it('sem log persistido, diz que nao existe — o defeito do smoke fica visivel', () => {
    renderPanel(makeNoChangesTaskDetail())
    expect(screen.getByTestId('log-refs-empty').textContent).toContain(
      'sem referência de log do agente persistida',
    )
    expect(screen.queryByTestId('log-refs')).toBeNull()
  })
})

describe('acessibilidade dos elementos novos', () => {
  it('estado, espera e falha sao texto — cor nunca informa sozinha', () => {
    const task: TaskDetail = { ...makeTaskDetail(), id: 'T11', status: 'PENDING' }
    renderPanel(task, pendingContext('T11'))
    expect(screen.getByTestId('waiting-cause').textContent).toMatch(/aguardando/)
    for (const icon of document.querySelectorAll('.activity__icon')) {
      expect(icon.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('todo botao do painel tem nome acessivel', () => {
    renderPanel(makeTaskDetail())
    for (const button of screen.getAllByRole('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? ''
      expect(name.trim().length).toBeGreaterThan(0)
    }
  })
})
