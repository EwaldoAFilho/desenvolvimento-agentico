import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RunSnapshot, TaskDetail } from '@agentic/schemas'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  ATTEMPTS_EXHAUSTED_BLOCKAGE,
  CROSS_PROVIDER_BLOCKAGE,
  makeBlockedTaskDetail,
  makeManyLogsTaskDetail,
  makeNoChangesTaskDetail,
  makeNoChangesWithLogTaskDetail,
  makeSnapshot,
  makeTaskDetail,
  makeTruncatedLogTaskDetail,
  POLICY_BLOCKAGE,
  withRunStatus,
  withSaturatedProviders,
  withTaskStatus,
} from '../__fixtures__/snapshot.js'
import { MAX_LISTED_LOGS } from '../lib/agent-log.js'
import { stalledDependents, waitingReasonOf } from '../lib/waiting.js'
import { TaskDetailPanel, type TaskPanelContext } from './TaskDetailPanel.js'

const noop = (): void => {}
const NOW = Date.parse('2026-01-08T12:45:42.000Z')

const HERE = dirname(fileURLToPath(import.meta.url))
const STYLESHEET = readFileSync(join(HERE, '..', 'styles.css'), 'utf8')

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

/** Renderiza o painel com o motivo de espera projetado do snapshot dado. */
function renderWaiting(snapshot: RunSnapshot, taskId: string, patch: Partial<TaskDetail> = {}) {
  const task: TaskDetail = { ...makeTaskDetail(), id: taskId, status: 'PENDING', ...patch }
  renderPanel(task, {
    now: NOW,
    waiting: waitingReasonOf(snapshot, taskId),
    stalled: stalledDependents(snapshot, taskId),
  })
  return screen.getByTestId('waiting-cause').textContent ?? ''
}

function group(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

function toggleOf(slug: string): HTMLElement {
  return within(screen.getByTestId(`group-${slug}`)).getAllByRole('button')[0] as HTMLElement
}

describe('motivo de espera: um caso por causa', () => {
  it('aguardando dependência nomeada', () => {
    expect(renderWaiting(makeSnapshot(), 'T11')).toBe('aguardando T09')
  })

  it('aguardando revisor', () => {
    const snapshot = withTaskStatus(makeSnapshot(), 'T12', { status: 'REVIEW' })
    expect(renderWaiting(snapshot, 'T12', { status: 'REVIEW' })).toBe('aguardando revisor')
  })

  it('aguardando revisor de outro fornecedor', () => {
    const snapshot = withTaskStatus(makeSnapshot(), 'T12', {
      status: 'BLOCKED',
      blockage: CROSS_PROVIDER_BLOCKAGE,
    })
    expect(renderWaiting(snapshot, 'T12', { status: 'BLOCKED' })).toBe(
      'aguardando revisor de outro fornecedor',
    )
  })

  it('aguardando capacidade do fornecedor', () => {
    const snapshot = withSaturatedProviders(makeSnapshot())
    expect(renderWaiting(snapshot, 'T12', { status: 'READY' })).toBe(
      'aguardando capacidade do fornecedor',
    )
  })

  it('aguardando vaga de execução do run', () => {
    let snapshot = makeSnapshot()
    for (const id of ['T11', 'T13', 'T15']) {
      snapshot = withTaskStatus(snapshot, id, { status: 'RUNNING' })
    }
    expect(renderWaiting(snapshot, 'T12', { status: 'READY' })).toBe('aguardando vaga de execução')
  })

  it('aguardando retry', () => {
    expect(renderWaiting(makeSnapshot(), 'T10', { status: 'RETRY' })).toBe(
      'aguardando nova tentativa',
    )
  })

  it('aguardando aprovação da missão', () => {
    const snapshot = withRunStatus(makeSnapshot(), 'DRAFT')
    expect(renderWaiting(snapshot, 'T12', { status: 'READY' })).toBe(
      'aguardando aprovação da missão',
    )
  })

  it('bloqueada por política', () => {
    const snapshot = withTaskStatus(makeSnapshot(), 'T12', {
      status: 'BLOCKED',
      blockage: POLICY_BLOCKAGE,
    })
    expect(renderWaiting(snapshot, 'T12', { status: 'BLOCKED' })).toBe('bloqueada por política')
  })

  it('aguardando decisão humana com as tentativas esgotadas', () => {
    const snapshot = withTaskStatus(makeSnapshot(), 'T12', {
      status: 'BLOCKED',
      blockage: ATTEMPTS_EXHAUSTED_BLOCKAGE,
    })
    expect(renderWaiting(snapshot, 'T12', { status: 'BLOCKED' })).toBe('aguardando decisão humana')
  })

  it('sem causa apurável, diz que está pronta e aguardando vaga — nunca inventa', () => {
    expect(renderWaiting(makeSnapshot(), 'T12', { status: 'READY' })).toBe(
      'pronta — aguardando vaga',
    )
    expect(screen.getByTestId('waiting-needs').textContent).toBe('—')
  })
})

describe('anatomia da falha', () => {
  it('cita a evidência mais recente registrada para a tentativa', () => {
    renderPanel(makeTaskDetail())
    const evidence = screen.getByTestId('failure-evidence')
    expect(evidence.getAttribute('data-origin')).toBe('evidence')
    expect(evidence.textContent).toContain('gate · gate-frontend-9')
    expect(evidence.textContent).toContain('runs/01J8ZC/T09/a2/gate.json')
  })

  it('sem evidência registrada, admite a ausência em vez de apontar arquivo inexistente', () => {
    renderPanel(makeNoChangesTaskDetail())
    const evidence = screen.getByTestId('failure-evidence')
    expect(evidence.getAttribute('data-origin')).toBe('none')
    expect(evidence.textContent).toBe('nenhuma evidência registrada para esta tentativa')
  })

  it('o grupo Falha nasce aberto quando existe falha', () => {
    renderPanel(makeTaskDetail())
    expect(screen.getByTestId('group-falha').getAttribute('data-open')).toBe('true')
  })

  it('sem falha, o grupo continua acessível mas nasce fechado', () => {
    renderPanel({ ...makeTaskDetail(), failure: undefined })
    expect(screen.getByTestId('group-falha').getAttribute('data-open')).toBe('false')
    expect(screen.getByTestId('failure-code').textContent).toBe('sem falha registrada')
  })
})

describe('anatomia do bloqueio', () => {
  it('diz o tipo do bloqueio em português, além do código', () => {
    renderPanel(makeBlockedTaskDetail(), {
      now: NOW,
      stalled: stalledDependents(makeSnapshot(), 'T09'),
    })
    expect(screen.getByTestId('blocked-kind').textContent).toBe('POLICY — política do produto')
  })

  it('diz o que precisa acontecer e quem ficou parado atrás', () => {
    renderPanel(makeBlockedTaskDetail(), {
      now: NOW,
      stalled: stalledDependents(makeSnapshot(), 'T09'),
    })
    const bloqueio = group('Bloqueio')
    expect(within(bloqueio).getByTestId('blocked-needs').textContent).toContain(
      'segundo fornecedor apto a revisar',
    )
    expect(within(bloqueio).getByTestId('blocked-dependents').textContent).toContain('T11 PENDING')
  })
})

describe('NO_CHANGES explicado', () => {
  it('as três afirmações aparecem juntas — nada de falha misteriosa', () => {
    renderPanel(makeNoChangesWithLogTaskDetail())
    const statements = screen.getByTestId('no-changes-statements').textContent ?? ''
    expect(statements).toContain('o agente concluiu a investigação')
    expect(statements).toContain('nenhuma alteração observada no repositório')
    expect(statements).toContain('não foi marcada DONE automaticamente')
  })

  it('aponta onde ler o que o agente concluiu', () => {
    renderPanel(makeNoChangesWithLogTaskDetail())
    expect(screen.getByTestId('no-changes-statements').textContent).toContain(
      '.agentic/runs/01J8ZC/attempts/T02-a2/agent.log.jsonl',
    )
  })

  it('o desfecho continua sendo o do domínio, e a tela diz que só oferece leitura', () => {
    renderPanel(makeNoChangesWithLogTaskDetail())
    expect(screen.getByTestId('no-changes-outcome').textContent).toContain('FAILED · NO_CHANGES')
    expect(screen.getByTestId('no-changes-reading').textContent).toContain(
      'nenhum estado novo foi criado',
    )
  })

  it('falha de outro código não ganha a leitura de NO_CHANGES', () => {
    renderPanel(makeTaskDetail())
    expect(screen.queryByRole('region', { name: 'Desfecho sem alteração' })).toBeNull()
  })
})

describe('log do agente', () => {
  it('lista o artefato com papel, tamanho e caminho copiável', () => {
    renderPanel(makeNoChangesWithLogTaskDetail())
    const logs = within(group('Log do agente')).getByTestId('agent-logs')
    expect(logs.textContent).toContain('executor')
    expect(logs.textContent).toContain('18,0 kB')
    expect(
      screen.getByRole('button', {
        name: 'copiar caminho do log: .agentic/runs/01J8ZC/attempts/T02-a2/agent.log.jsonl',
      }),
    ).toBeTruthy()
  })

  it('log truncado é anunciado como truncado — nunca finge completo', () => {
    renderPanel(makeTruncatedLogTaskDetail())
    const notice = screen.getByTestId('log-notice')
    expect(notice.getAttribute('data-truncated')).toBe('true')
    expect(notice.textContent).toContain('NÃO está completa')
    expect(screen.getByTestId('agent-log-truncated').textContent).toContain('truncado')
  })

  it('saída de comando truncada aparece junto do comando', () => {
    renderPanel(makeTruncatedLogTaskDetail())
    expect(within(group('Qualidade')).getByTestId('command-truncated').textContent).toContain(
      'não é a saída completa',
    )
  })

  it('saída grande não trava a tela: a lista tem teto e diz quantos ficaram de fora', () => {
    renderPanel(makeManyLogsTaskDetail(60))
    expect(within(group('Log do agente')).getByTestId('agent-logs').children).toHaveLength(
      MAX_LISTED_LOGS,
    )
    const bounded = screen.getByTestId('log-bounded').textContent ?? ''
    expect(bounded).toContain('não é carregado aqui')
    expect(bounded).toContain('não listado(s)')
  })

  it('sem artefato de log, diz que não existe', () => {
    renderPanel(makeNoChangesTaskDetail())
    expect(screen.getByTestId('agent-logs-empty').textContent).toContain(
      'nenhum log do agente foi persistido',
    )
    expect(screen.queryByTestId('agent-logs')).toBeNull()
  })
})

describe('hierarquia visual e revelação progressiva', () => {
  it('o resumo sempre visível traz estado, fase, executor, revisor, tentativa e duração', () => {
    renderPanel(makeTaskDetail())
    expect(screen.getByTestId('detail-status').textContent).toContain('RUNNING')
    expect(screen.getByTestId('summary-phase').textContent).toBe('frontend')
    expect(screen.getByTestId('summary-executor').textContent).toBe('frontend-executor (agente-a)')
    expect(screen.getByTestId('summary-reviewer').textContent).toBe(
      'revisor-independente (agente-b)',
    )
    expect(screen.getByTestId('summary-attempt').textContent).toBe('tentativa 2/3 · 4m12s')
  })

  it('o material de referência nasce fechado; o que exige atenção nasce aberto', () => {
    renderPanel(makeTaskDetail())
    for (const slug of ['isolamento', 'escopo', 'grafo', 'eventos', 'log-do-agente']) {
      expect(screen.getByTestId(`group-${slug}`).getAttribute('data-open')).toBe('false')
    }
    for (const slug of ['falha', 'atividade']) {
      expect(screen.getByTestId(`group-${slug}`).getAttribute('data-open')).toBe('true')
    }
  })

  it('o grupo fechado mostra um resumo antes de abrir', () => {
    renderPanel(makeTaskDetail())
    expect(screen.getByTestId('hint-isolamento').textContent).toBe('agentic/DA-BPM-021/T09')
    expect(screen.getByTestId('hint-fatos').textContent).toBe('2 arquivos · +204 −12')
    expect(screen.getByTestId('hint-escopo').textContent).toBe('1 touch · sem violação')
  })

  it('abrir e fechar um grupo é uma ação do usuário, não um efeito de re-render', () => {
    renderPanel(makeTaskDetail())
    const toggle = toggleOf('isolamento')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('group-isolamento').getAttribute('data-open')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('o grupo aberto pelo usuário sobrevive ao relógio do cabeçalho', () => {
    const panel = (now: number) => (
      <TaskDetailPanel
        task={makeTaskDetail()}
        context={{ now }}
        onClose={noop}
        onRetry={noop}
        onUnblock={noop}
        onSkip={noop}
      />
    )
    const view = render(panel(NOW))
    fireEvent.click(toggleOf('isolamento'))
    expect(screen.getByTestId('group-isolamento').getAttribute('data-open')).toBe('true')
    // O dashboard re-renderiza a cada segundo: abrir um grupo nao pode ser desfeito por isso.
    view.rerender(panel(NOW + 1000))
    expect(screen.getByTestId('group-isolamento').getAttribute('data-open')).toBe('true')
  })

  it('trocar de task devolve os grupos ao estado padrão', () => {
    const view = render(
      <TaskDetailPanel
        task={makeTaskDetail()}
        context={{ now: NOW }}
        onClose={noop}
        onRetry={noop}
        onUnblock={noop}
        onSkip={noop}
      />,
    )
    fireEvent.click(toggleOf('isolamento'))
    expect(screen.getByTestId('group-isolamento').getAttribute('data-open')).toBe('true')
    view.rerender(
      <TaskDetailPanel
        task={makeNoChangesTaskDetail()}
        context={{ now: NOW }}
        onClose={noop}
        onRetry={noop}
        onUnblock={noop}
        onSkip={noop}
      />,
    )
    expect(screen.getByTestId('group-isolamento').getAttribute('data-open')).toBe('false')
  })

  it('a folha de estilo esconde de fato o corpo do grupo fechado', () => {
    expect(STYLESHEET).toMatch(
      /\.group\[data-open="false"\]\s+\.group__body\s*\{\s*display:\s*none/,
    )
  })
})

describe('acessibilidade dos elementos novos', () => {
  it('todo controle de grupo tem nome acessível e diz se está aberto', () => {
    renderPanel(makeTruncatedLogTaskDetail())
    const toggles = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-expanded') !== null)
    expect(toggles.length).toBeGreaterThanOrEqual(10)
    for (const toggle of toggles) {
      expect((toggle.textContent ?? '').trim().length).toBeGreaterThan(0)
      expect(['true', 'false']).toContain(toggle.getAttribute('aria-expanded'))
      const controlled = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
      expect(controlled?.getAttribute('aria-label')).toBeTruthy()
    }
  })

  it('o chevron do grupo é decoração — quem informa é o rótulo', () => {
    renderPanel(makeTaskDetail())
    const chevrons = document.querySelectorAll('.group__chevron')
    expect(chevrons.length).toBeGreaterThan(0)
    for (const chevron of chevrons) {
      expect(chevron.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('a truncagem é texto, não cor', () => {
    renderPanel(makeTruncatedLogTaskDetail())
    expect(screen.getByTestId('log-notice').textContent).toMatch(/truncad/)
  })

  it('o desfecho sem alteração é texto, não cor', () => {
    renderPanel(makeNoChangesTaskDetail())
    expect(screen.getByTestId('no-changes-outcome').textContent).toMatch(/NO_CHANGES/)
  })
})
