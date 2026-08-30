import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  makeCompileReport,
  makeSnapshot,
  PROVIDERS_WITH_ENVIRONMENT,
} from '../__fixtures__/snapshot.js'
import { TASK_STATUSES, taskStatusStyle } from '../lib/status.js'
import { installReactFlowEnv } from '../test/react-flow-env.js'
import { DagCanvas } from './DagCanvas.js'
import { ProvidersPanel } from './ProvidersPanel.js'
import { StartMission } from './StartMission.js'

installReactFlowEnv()

const noop = (): void => {}

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
