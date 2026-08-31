import type { CompileReportDto, ProjectHomeDto, RunHeaderDto } from '@agentic/schemas'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeEmptyProjectHome, makeIdleProjectHome, makeProjectHome } from './__fixtures__/home.js'
import { makeCompileReport, makeSnapshot, PROVIDERS } from './__fixtures__/snapshot.js'
import { App, type AppDeps } from './App.js'
import { ApiError } from './api.js'
import type { EventSourceLike, RunStreamDeps } from './hooks/useRunStream.js'
import { installReactFlowEnv } from './test/react-flow-env.js'

installReactFlowEnv()

/** SSE de mentira: o que se prova aqui e a entrada da aplicacao, nao o stream. */
const SILENT_SOURCE: EventSourceLike = { addEventListener: () => {}, close: () => {} }

const RUN_STREAM: RunStreamDeps = {
  fetchSnapshot: async () => makeSnapshot(),
  createEventSource: () => SILENT_SOURCE,
}

function approvedRun(missionId: string): RunHeaderDto {
  return {
    id: '01J8ZC0X00000000000APPROVED',
    missionId,
    status: 'APPROVED',
    timestamps: { createdAt: '2026-01-08T12:05:00.000Z' },
    policies: makeSnapshot().run.policies,
  }
}

function goTo(search: string): void {
  window.history.replaceState({}, '', search.length === 0 ? '/' : `/${search}`)
}

function renderApp(deps: Partial<AppDeps> = {}) {
  return render(<App deps={deps} runStream={RUN_STREAM} />)
}

afterEach(() => {
  goTo('')
})

describe('sem run e sem missao na URL', () => {
  it('a Home do projeto aparece e nenhum carregamento fica indefinido', async () => {
    goTo('')
    renderApp({ loadProjectHome: async () => makeIdleProjectHome() })

    expect(await screen.findByRole('main', { name: 'Projeto' })).toBeTruthy()
    expect(screen.queryByText(/carregando missão compilada/i)).toBeNull()
    expect(screen.queryByText(/carregando/i)).toBeNull()
  })

  it('projeto novo, sem missao e sem execucao, mostra estado vazio honesto', async () => {
    goTo('')
    renderApp({ loadProjectHome: async () => makeEmptyProjectHome() })

    expect(await screen.findByTestId('missions-empty')).toBeTruthy()
    expect(screen.getByTestId('runs-empty')).toBeTruthy()
  })

  it('a Home nao pede compilacao de missao nenhuma', async () => {
    goTo('')
    const loadCompileReport = vi.fn(async () => makeCompileReport('clean'))
    renderApp({ loadProjectHome: async () => makeIdleProjectHome(), loadCompileReport })

    await screen.findByRole('main', { name: 'Projeto' })
    expect(loadCompileReport).not.toHaveBeenCalled()
  })
})

describe('falha de backend', () => {
  it('vira mensagem com acao de tentar novamente, nao tela pendurada', async () => {
    goTo('')
    const loadProjectHome = vi.fn(async (): Promise<ProjectHomeDto> => {
      throw new ApiError(
        500,
        JSON.stringify({
          error: {
            code: 'MISSIONS_DIR_UNREADABLE',
            message: 'nao foi possivel ler .agentic/missions (EACCES)',
          },
        }),
      )
    })
    renderApp({ loadProjectHome })

    const message = await screen.findByTestId('error-message')
    expect(message.textContent).toContain('MISSIONS_DIR_UNREADABLE')
    expect(screen.queryByText(/carregando/i)).toBeNull()
    expect(screen.getByTestId('retry')).toBeTruthy()
    expect(loadProjectHome).toHaveBeenCalledTimes(1)
  })

  it('tentar novamente pede de novo — e a Home aparece quando o servidor volta', async () => {
    goTo('')
    let falhas = 1
    const loadProjectHome = vi.fn(async (): Promise<ProjectHomeDto> => {
      if (falhas > 0) {
        falhas -= 1
        throw new ApiError(503, 'control plane indisponível')
      }
      return makeIdleProjectHome()
    })
    renderApp({ loadProjectHome })

    await screen.findByTestId('retry')
    fireEvent.click(screen.getByTestId('retry'))

    expect(await screen.findByRole('main', { name: 'Projeto' })).toBeTruthy()
    expect(loadProjectHome).toHaveBeenCalledTimes(2)
  })

  it('pedido que nunca responde vira erro com saida, nao carregamento eterno', async () => {
    goTo('')
    // Conexao aceita e nunca respondida: a promessa nunca assenta, e era isso que deixava a
    // tela carregando sem nada ter dado errado.
    const pendente = new Promise<ProjectHomeDto>(() => {})
    render(
      <App deps={{ loadProjectHome: () => pendente }} runStream={RUN_STREAM} bootTimeoutMs={20} />,
    )

    expect((await screen.findByTestId('error-message')).textContent).toContain('não respondeu')
    expect(screen.getByTestId('retry')).toBeTruthy()
  })

  it('a segunda falha identica e distinguivel da primeira', async () => {
    goTo('')
    const loadProjectHome = vi.fn(async (): Promise<ProjectHomeDto> => {
      throw new ApiError(503, 'control plane indisponível')
    })
    renderApp({ loadProjectHome })

    const primeira = (await screen.findByTestId('error-message')).textContent
    expect(primeira).not.toContain('tentativa')

    fireEvent.click(screen.getByTestId('retry'))
    await waitFor(() =>
      expect(screen.getByTestId('error-message').textContent).toContain('tentativa 2'),
    )
  })

  it('falha ao compilar a missao da URL tambem tem saida — inclusive para a Home', async () => {
    goTo('?mission=DA-BPM-021')
    renderApp({
      loadCompileReport: async (): Promise<CompileReportDto> => {
        throw new ApiError(404, 'missao DA-BPM-021 nao encontrada')
      },
      loadProjectHome: async () => makeIdleProjectHome(),
    })

    expect((await screen.findByTestId('error-message')).textContent).toContain('404')
    fireEvent.click(screen.getByTestId('go-home'))
    expect(await screen.findByRole('main', { name: 'Projeto' })).toBeTruthy()
  })
})

describe('a guarda de run continua ganhando', () => {
  it('com run na URL o dashboard de execucao assume sem passar pela Home', async () => {
    goTo('?run=01J8ZC0X0000000000000000AA')
    const loadProjectHome = vi.fn(async () => makeProjectHome())
    renderApp({ loadProjectHome })

    expect(await screen.findByRole('region', { name: 'Canvas do DAG' })).toBeTruthy()
    expect(loadProjectHome).not.toHaveBeenCalled()
  })

  it('com execucao ativa e sem URL, o dashboard ganha da Home', async () => {
    goTo('')
    renderApp({ loadProjectHome: async () => makeProjectHome() })

    expect(await screen.findByRole('region', { name: 'Canvas do DAG' })).toBeTruthy()
    expect(screen.queryByRole('main', { name: 'Projeto' })).toBeNull()
    // O desvio automatico troca a URL para que o F5 caia no mesmo run.
    expect(window.location.search).toContain('run=')
  })

  it('run na URL vence a missao na URL', async () => {
    goTo('?run=01J8ZC0X0000000000000000AA&mission=DA-BPM-021')
    const loadCompileReport = vi.fn(async () => makeCompileReport('clean'))
    renderApp({ loadCompileReport })

    expect(await screen.findByRole('region', { name: 'Canvas do DAG' })).toBeTruthy()
    expect(loadCompileReport).not.toHaveBeenCalled()
  })
})

describe('a tela de missao compilada continua', () => {
  it('com missao na URL a tela de partida aparece com os numeros do compilador', async () => {
    goTo('?mission=DA-BPM-021')
    renderApp({
      loadCompileReport: async () => makeCompileReport('warning'),
      loadProviders: async () => PROVIDERS,
      loadRuns: async () => [],
    })

    expect(await screen.findByRole('main', { name: 'Missão compilada' })).toBeTruthy()
    expect(screen.getByTestId('mission-status').textContent).toContain('DRAFT')
  })

  it('aprovacao vem de um run DESTA missao, nao do run mais recente do projeto', async () => {
    goTo('?mission=DA-BPM-021')
    renderApp({
      loadCompileReport: async () => makeCompileReport('clean'),
      loadProviders: async () => PROVIDERS,
      // Run aprovado de OUTRA missao: nao pode aprovar esta por tabela.
      loadRuns: async () => [approvedRun('DA-OUTRA-999')],
    })

    await screen.findByRole('main', { name: 'Missão compilada' })
    expect(screen.getByTestId('mission-status').textContent).toContain('DRAFT')
  })

  it('run aprovado da propria missao destrava a partida', async () => {
    goTo('?mission=DA-BPM-021')
    renderApp({
      loadCompileReport: async () => makeCompileReport('clean'),
      loadProviders: async () => PROVIDERS,
      loadRuns: async () => [approvedRun('DA-BPM-021')],
    })

    await screen.findByRole('main', { name: 'Missão compilada' })
    expect(screen.getByTestId('mission-status').textContent).toContain('APPROVED')
  })

  it('a partida entrega a tela ao run e escreve o run na URL', async () => {
    goTo('?mission=DA-BPM-021')
    const start = vi.fn(async () => '01J8ZC0X0000000000000000AA')
    renderApp({
      loadCompileReport: async () => makeCompileReport('clean'),
      loadProviders: async () => PROVIDERS,
      loadRuns: async () => [approvedRun('DA-BPM-021')],
      start,
    })

    await screen.findByRole('main', { name: 'Missão compilada' })
    fireEvent.change(screen.getByLabelText(/actor/i), { target: { value: 'ewaldo' } })
    fireEvent.click(screen.getByTestId('start-mission'))

    expect(await screen.findByRole('region', { name: 'Canvas do DAG' })).toBeTruthy()
    await waitFor(() => expect(window.location.search).toContain('run='))
    expect(start).toHaveBeenCalledTimes(1)
  })
})
