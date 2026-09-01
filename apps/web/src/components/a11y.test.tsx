import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { makeProjectHome } from '../__fixtures__/home.js'
import {
  makePlanResult,
  REAL_PLANNER,
  SECOND_PLANNER,
  SIMULATED_PLANNER,
} from '../__fixtures__/planning.js'
import {
  makeCompileReport,
  makeSnapshot,
  PROVIDERS_WITH_ENVIRONMENT,
} from '../__fixtures__/snapshot.js'
import { TASK_STATUSES, taskStatusStyle } from '../lib/status.js'
import { installReactFlowEnv } from '../test/react-flow-env.js'
import { DagCanvas } from './DagCanvas.js'
import { ErrorScreen } from './ErrorScreen.js'
import { NewMission, type NewMissionDeps } from './NewMission.js'
import { ProjectHome } from './ProjectHome.js'
import { ProvidersPanel } from './ProvidersPanel.js'
import { StartMission } from './StartMission.js'

installReactFlowEnv()

const noop = (): void => {}

/** Planejamento de mentira: acessibilidade se prova sem gastar assinatura de ninguem. */
function renderNewMission(planners = [REAL_PLANNER, SECOND_PLANNER, SIMULATED_PLANNER]) {
  const deps: Partial<NewMissionDeps> = {
    loadPlanners: async () => planners,
    plan: async () => ({ kind: 'planned' as const, result: makePlanResult() }),
    loadSnapshot: async () => makeSnapshot(),
  }
  return render(<NewMission deps={deps} onCancel={noop} onOpenMission={noop} />)
}

/**
 * O jsdom do teste nao carrega `styles.css`, entao `element.style.outline` nunca diz nada
 * sobre o anel de foco: quem responde por ele e a folha de estilo. Lida como texto, ela e
 * verificavel — apagar o contorno passa a quebrar teste.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const STYLESHEET = readFileSync(join(HERE, '..', 'styles.css'), 'utf8')

describe('foco pelo teclado', () => {
  it('todo controle da tela de partida recebe foco pelo teclado', () => {
    render(
      <StartMission
        report={makeCompileReport('warning')}
        approved
        providers={PROVIDERS_WITH_ENVIRONMENT}
        onApprove={noop}
        onStart={noop}
      />,
    )
    fireEvent.change(screen.getByLabelText(/actor/i), { target: { value: 'ewaldo' } })
    const controls = [...screen.getAllByRole('button'), ...screen.getAllByRole('textbox')].filter(
      (control) => !control.hasAttribute('disabled'),
    )
    expect(controls.length).toBeGreaterThanOrEqual(2)
    for (const control of controls) {
      control.focus()
      expect(document.activeElement).toBe(control)
    }
  })

  it('a folha de estilo desenha o anel de foco e nao apaga o contorno de ninguem', () => {
    expect(STYLESHEET).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid/)
    expect(STYLESHEET).not.toMatch(/outline:\s*none/)
  })

  it('o no do canvas e focavel pelo teclado', () => {
    render(
      <DagCanvas
        snapshot={makeSnapshot()}
        grouping="phase"
        onGroupingChange={noop}
        onSelectTask={noop}
      />,
    )
    const node = document.querySelector('.react-flow__node-task') as HTMLElement | null
    expect(node?.getAttribute('tabindex')).toBe('0')
    node?.focus()
    expect(document.activeElement).toBe(node)
  })
})

describe('cor nunca e o unico diferenciador', () => {
  it('cada estado tem icone e rotulo textual distintos', () => {
    const icons = new Set(TASK_STATUSES.map((status) => taskStatusStyle(status).icon))
    const labels = new Set(TASK_STATUSES.map((status) => taskStatusStyle(status).label))
    expect(icons.size).toBe(TASK_STATUSES.length)
    expect(labels.size).toBe(TASK_STATUSES.length)
  })

  it('o motivo de espera do no e texto, e o icone continua escondido do leitor', () => {
    render(
      <DagCanvas
        snapshot={makeSnapshot()}
        grouping="phase"
        onGroupingChange={noop}
        onSelectTask={noop}
      />,
    )
    const node = screen.getByTestId('task-node-T11')
    expect(node.querySelector('.task-node__waiting')?.textContent).toContain('aguardando')
    expect(node.querySelector('.task-node__icon')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('a linha de ambiente do provider e texto, nao um ponto colorido', () => {
    render(<ProvidersPanel providers={PROVIDERS_WITH_ENVIRONMENT} />)
    const env = screen.getByTestId('provider-agente-b-env')
    expect(env.textContent).toContain('resolvedPath')
    expect(env.textContent).toContain('readinessSource')
    expect(env.textContent).toContain('diagnostic')
  })
})

describe('rotulos acessiveis dos controles', () => {
  it('os botoes de agrupamento anunciam qual esta ativo', () => {
    render(
      <DagCanvas
        snapshot={makeSnapshot()}
        grouping="wave"
        onGroupingChange={noop}
        onSelectTask={noop}
      />,
    )
    expect(screen.getByRole('button', { name: 'por onda' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(screen.getByRole('button', { name: 'por fase' }).getAttribute('aria-pressed')).toBe(
      'false',
    )
  })

  it('todo botao da tela de partida tem nome acessivel', () => {
    render(
      <StartMission
        report={makeCompileReport('warning')}
        approved
        providers={PROVIDERS_WITH_ENVIRONMENT}
        onApprove={noop}
        onStart={noop}
      />,
    )
    for (const button of screen.getAllByRole('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? ''
      expect(name.trim().length).toBeGreaterThan(0)
    }
  })

  it('todo controle da Home recebe foco e anuncia a que missao pertence', () => {
    render(
      <ProjectHome
        home={makeProjectHome()}
        onOpenRun={noop}
        onOpenMission={noop}
        onNewMission={noop}
        onReload={noop}
      />,
    )
    const controls = screen.getAllByRole('button').filter((b) => !b.hasAttribute('disabled'))
    expect(controls.length).toBeGreaterThanOrEqual(4)
    const names = new Set<string>()
    for (const control of controls) {
      const name = (control.getAttribute('aria-label') ?? control.textContent ?? '').trim()
      expect(name.length).toBeGreaterThan(0)
      names.add(name)
      control.focus()
      expect(document.activeElement).toBe(control)
    }
    // "ver execução" repetido em cinco linhas nao diz a ninguem QUAL execucao vai abrir.
    expect(names.size).toBe(controls.length)
  })

  it('a Home diz o estado por texto, nao so por cor', () => {
    render(
      <ProjectHome
        home={makeProjectHome()}
        onOpenRun={noop}
        onOpenMission={noop}
        onNewMission={noop}
        onReload={noop}
      />,
    )
    // O veredito do ambiente e uma frase — o `data-verdict` serve ao CSS, nao ao leitor.
    const verdict = screen.getByTestId('environment-verdict')
    expect(verdict.textContent).toContain('ambiente com pendência')
    expect(verdict.textContent).toContain('indisponível')
    expect(screen.getByTestId('mission-DA-DOC-004').textContent).toContain('CONCLUÍDA')
  })

  it('a tela de falha anuncia o erro e oferece um botao com nome', () => {
    render(<ErrorScreen title="O control plane não respondeu" message="HTTP 500" onRetry={noop} />)
    expect(screen.getByRole('main', { name: 'O control plane não respondeu' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('HTTP 500')
    const retry = screen.getByRole('button', { name: 'tentar novamente' })
    retry.focus()
    expect(document.activeElement).toBe(retry)
  })

  it('todo controle da tela de nova missao tem rotulo e recebe foco pelo teclado', async () => {
    renderNewMission()
    await screen.findByTestId('plan-mission')
    fireEvent.change(screen.getByLabelText(/o que você quer que seja feito/i), {
      target: { value: 'quero um relatório de estoque' },
    })
    fireEvent.change(screen.getByLabelText(/actor/i), { target: { value: 'ewaldo' } })
    fireEvent.click(screen.getByLabelText(/consome a minha assinatura/i))

    const controls = [
      ...screen.getAllByRole('button'),
      ...screen.getAllByRole('textbox'),
      ...screen.getAllByRole('combobox'),
      ...screen.getAllByRole('checkbox'),
    ].filter((control) => !control.hasAttribute('disabled'))
    expect(controls.length).toBeGreaterThanOrEqual(5)
    for (const control of controls) {
      control.focus()
      expect(document.activeElement).toBe(control)
    }
    for (const button of screen.getAllByRole('button')) {
      const name = (button.getAttribute('aria-label') ?? button.textContent ?? '').trim()
      expect(name.length).toBeGreaterThan(0)
    }
  })

  it('o aviso de consumo e legivel sem cor: icone escondido, frase a vista', async () => {
    renderNewMission()
    const notice = await screen.findByTestId('subscription-notice')
    // `data-consumes` serve ao CSS; quem le a tela recebe a frase inteira.
    expect(notice.getAttribute('data-consumes')).toBe('true')
    expect(notice.textContent).toContain('consome a sua assinatura')
    expect(notice.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })

  it('o estado do planejador chega como texto, nao como cor', async () => {
    renderNewMission()
    const state = await screen.findByTestId('planner-state')
    expect(state.textContent).toContain('observado pronto')
  })

  it('a espera e a razao de nao poder partir sao anunciadas por role=status', async () => {
    renderNewMission()
    const phase = await screen.findByTestId('plan-phase')
    expect(phase.getAttribute('role')).toBe('status')
    expect(phase.textContent).toContain('descreva o que você quer')
  })

  it('o campo de actor continua associado ao seu rotulo', () => {
    render(
      <StartMission
        report={makeCompileReport('clean')}
        approved
        providers={PROVIDERS_WITH_ENVIRONMENT}
        onApprove={noop}
        onStart={noop}
      />,
    )
    expect(screen.getByLabelText(/actor/i).getAttribute('id')).toBe('actor')
  })
})
