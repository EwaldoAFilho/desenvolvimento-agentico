import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  COMPLETED_RUN,
  makeEmptyProjectHome,
  makeProjectHome,
  READY_PROVIDER,
  RUNNING_RUN,
} from '../__fixtures__/home.js'
import { ProjectHome } from './ProjectHome.js'

const noop = (): void => {}

function renderHome(overrides: Partial<Parameters<typeof ProjectHome>[0]> = {}) {
  const props = {
    home: makeProjectHome(),
    onOpenRun: noop,
    onOpenMission: noop,
    onReload: noop,
    ...overrides,
  }
  return render(<ProjectHome {...props} />)
}

describe('identidade e ambiente do projeto', () => {
  it('a Home diz de que projeto se trata e onde as missoes moram', () => {
    renderHome()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('projeto-exemplo')
    expect(screen.getByRole('main', { name: 'Projeto' }).textContent).toContain('.agentic/missions')
  })

  it('fornecedor com prontidao nao apurada nao e pintado como pronto', () => {
    renderHome()
    const verdict = screen.getByTestId('environment-verdict')
    expect(verdict.getAttribute('data-verdict')).not.toBe('READY')
    // O painel completo continua mostrando `unknown` como `unknown`.
    expect(screen.getByTestId('provider-agente-a').textContent).toContain('unknown')
  })

  it('ambiente inteiramente observado pronto pode dizer que esta pronto', () => {
    const home = makeProjectHome()
    renderHome({ home: { ...home, project: { ...home.project, providers: [READY_PROVIDER] } } })
    expect(screen.getByTestId('environment-verdict').getAttribute('data-verdict')).toBe('READY')
  })

  it('projeto sem fornecedor explica o vazio em vez de mostrar tabela vazia', () => {
    renderHome({ home: makeEmptyProjectHome() })
    expect(screen.getByTestId('environment-verdict').getAttribute('data-verdict')).toBe('NONE')
    expect(screen.queryByRole('region', { name: 'Providers' })).toBeNull()
  })
})

describe('missoes com acao coerente com o estado', () => {
  it('missao que nao compila aparece na lista e nao oferece acao nenhuma', () => {
    renderHome()
    const row = screen.getByTestId('mission-.agentic/missions/quebrada.mission.yaml')
    expect(row.textContent).toContain('INVÁLIDA')
    expect(row.querySelector('button')).toBeNull()
    expect(row.textContent).toContain('não compila')
  })

  it('missao em execucao leva ao run que ja existe', () => {
    const onOpenRun = vi.fn()
    renderHome({ onOpenRun })
    fireEvent.click(screen.getByRole('button', { name: /acompanhar execução/ }))
    expect(onOpenRun).toHaveBeenCalledWith(RUNNING_RUN.id)
  })

  it('missao sem execucao leva a tela da missao, com o id que o arquivo declarou', () => {
    const onOpenMission = vi.fn()
    renderHome({ onOpenMission })
    fireEvent.click(screen.getByRole('button', { name: /abrir missão: Tela de listagem/ }))
    expect(onOpenMission).toHaveBeenCalledWith('DA-UI-003')
  })

  it('cada missao mostra os numeros do compilador', () => {
    renderHome()
    const row = screen.getByTestId('mission-DA-BPM-021')
    expect(row.textContent).toContain('12 tasks')
    expect(row.textContent).toContain('2 avisos')
  })
})

describe('execucoes', () => {
  it('a lista de execucoes abre o run pelo id', () => {
    const onOpenRun = vi.fn()
    renderHome({ onOpenRun })
    const row = screen.getByTestId(`run-${COMPLETED_RUN.id}`)
    const open = row.querySelector('button')
    expect(open).not.toBeNull()
    fireEvent.click(open as HTMLButtonElement)
    expect(onOpenRun).toHaveBeenCalledWith(COMPLETED_RUN.id)
  })

  it('run sem contadores apurados nao vira uma linha de zeros', () => {
    const home = makeProjectHome()
    const semContadores = { ...COMPLETED_RUN, counters: undefined }
    renderHome({ home: { ...home, runs: [semContadores] } })
    const row = screen.getByTestId(`run-${COMPLETED_RUN.id}`)
    expect(row.textContent).toContain('não apurados')
    expect(row.textContent).not.toContain('0/0 DONE')
  })
})

describe('estado vazio honesto', () => {
  it('projeto novo diz que nao ha missao e onde criar a primeira', () => {
    renderHome({ home: makeEmptyProjectHome() })
    expect(screen.getByTestId('missions-empty').textContent).toContain('.agentic/missions')
    expect(screen.getByTestId('runs-empty').textContent).toContain('nenhuma execução ainda')
  })

  it('nada na Home fica em carregamento indefinido', () => {
    renderHome({ home: makeEmptyProjectHome() })
    expect(screen.queryByText(/carregando/i)).toBeNull()
  })
})

describe('acessibilidade da Home', () => {
  it('todo botao tem nome acessivel e recebe foco pelo teclado', () => {
    renderHome()
    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('disabled'))
    expect(buttons.length).toBeGreaterThanOrEqual(4)
    for (const button of buttons) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? ''
      expect(name.trim().length).toBeGreaterThan(0)
      button.focus()
      expect(document.activeElement).toBe(button)
    }
  })

  it('cada acao diz a QUAL missao pertence — "ver execução" sozinho e ambiguo', () => {
    renderHome()
    expect(screen.getByRole('button', { name: 'ver execução: Manual de operação' })).toBeTruthy()
  })

  it('estado de missao e de run chega como texto, nao so como cor', () => {
    renderHome()
    const row = screen.getByTestId('mission-DA-BPM-021')
    expect(row.textContent).toContain('EM EXECUÇÃO')
    expect(screen.getByTestId(`run-${RUNNING_RUN.id}`).textContent).toContain('RUNNING')
  })

  it('atualizar anuncia que esta em curso e nao aceita segundo clique', () => {
    const onReload = vi.fn()
    renderHome({ onReload, reloading: true })
    const button = screen.getByTestId('reload-home')
    expect(button.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(button)
    expect(onReload).not.toHaveBeenCalled()
  })
})
