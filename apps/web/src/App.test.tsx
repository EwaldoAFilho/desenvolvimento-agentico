import type {
  CompileReportDto,
  MissionSummaryDto,
  ProjectHomeDto,
  RunHeaderDto,
} from '@agentic/schemas'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeEmptyProjectHome, makeIdleProjectHome, makeProjectHome } from './__fixtures__/home.js'
import {
  makeDraftResult,
  makeDraftSnapshot,
  makePlanResult,
  makePlanTaskDetail,
  REAL_PLANNER,
} from './__fixtures__/planning.js'
import { makeCompileReport, makeSnapshot, PROVIDERS } from './__fixtures__/snapshot.js'
import { App, type AppDeps } from './App.js'
import { ApiError, type PlanOutcome } from './api.js'
import type { NewMissionDeps } from './components/NewMission.js'
import type { PlanReviewDeps } from './components/PlanReview.js'
import type { EventSourceLike, RunStreamDeps } from './hooks/useRunStream.js'
import { installReactFlowEnv } from './test/react-flow-env.js'

installReactFlowEnv()

/** SSE de mentira: o que se prova aqui e a entrada da aplicacao, nao o stream. */
const SILENT_SOURCE: EventSourceLike = { addEventListener: () => {}, close: () => {} }

const RUN_STREAM: RunStreamDeps = {
  fetchSnapshot: async () => makeSnapshot(),
  createEventSource: () => SILENT_SOURCE,
}

/**
 * O run precisa declarar QUAL versao do plano ele aprovou. Sem `specHash` a tela nao pode
 * distinguir "esta missao ja foi aprovada" de "esta VERSAO do plano ja foi aprovada" — e um
 * run antigo faria um YAML novo nascer aprovado.
 */
const REPORT_SPEC_HASH = 'sha256:limpo'

function approvedRun(missionId: string, specHash = REPORT_SPEC_HASH): RunHeaderDto {
  return {
    id: '01J8ZC0X00000000000APPROVED',
    missionId,
    status: 'APPROVED',
    specHash,
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

/** Planejamento de mentira: nenhum teste desta suite aciona agente nem gasta assinatura. */
const PLAN_DEPS: Partial<NewMissionDeps> = {
  loadPlanners: async () => [REAL_PLANNER],
  plan: async (): Promise<PlanOutcome> => ({ kind: 'planned', result: makePlanResult() }),
  loadSnapshot: async () => makeSnapshot(),
}

function renderAppWithPlanning(deps: Partial<AppDeps> = {}) {
  return render(<App deps={deps} runStream={RUN_STREAM} newMission={PLAN_DEPS} />)
}

/** Revisao do plano sem servidor: o rascunho e congelado de mentira, e nada e executado. */
const REVIEW_DEPS: Partial<PlanReviewDeps> = {
  createDraft: async () => makeDraftResult(),
  loadSnapshot: async () => makeDraftSnapshot(),
  loadTaskDetail: async () => makePlanTaskDetail(),
}

const MISSION_FILE = '.agentic/missions/DA-BPM-021.mission.yaml'

function missionSummary(missionId: string): MissionSummaryDto {
  return {
    id: missionId,
    file: MISSION_FILE,
    title: 'Refinar painel de propriedades',
    state: 'DRAFT',
    tasks: 17,
    phases: 7,
    errors: 0,
    warnings: 0,
  }
}

function renderMissionScreen(deps: Partial<AppDeps> = {}) {
  return render(
    <App
      deps={{
        loadCompileReport: async () => makeCompileReport('clean'),
        loadProviders: async () => PROVIDERS,
        loadRuns: async () => [],
        loadMissions: async () => [missionSummary('DA-BPM-021')],
        ...deps,
      }}
      runStream={RUN_STREAM}
      planReview={REVIEW_DEPS}
    />,
  )
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

describe('nova missao por linguagem natural', () => {
  it('a Home leva a tela de nova missao e o endereco fica na URL', async () => {
    goTo('')
    renderAppWithPlanning({ loadProjectHome: async () => makeIdleProjectHome() })

    await screen.findByRole('main', { name: 'Projeto' })
    fireEvent.click(screen.getByTestId('new-mission'))

    expect(await screen.findByRole('main', { name: 'Nova missão' })).toBeTruthy()
    expect(window.location.search).toContain('new=')
  })

  it('com ?new na URL a tela abre direto, sem passar pela Home', async () => {
    goTo('?new=1')
    const loadProjectHome = vi.fn(async () => makeIdleProjectHome())
    renderAppWithPlanning({ loadProjectHome })

    expect(await screen.findByRole('main', { name: 'Nova missão' })).toBeTruthy()
    expect(loadProjectHome).not.toHaveBeenCalled()
  })

  it('execucao ativa nao sequestra quem esta escrevendo o pedido', async () => {
    goTo('?new=1')
    // `makeProjectHome` tem um run RUNNING: sem a guarda, o dashboard tomaria a tela.
    renderAppWithPlanning({ loadProjectHome: async () => makeProjectHome() })

    expect(await screen.findByRole('main', { name: 'Nova missão' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Canvas do DAG' })).toBeNull()
  })

  it('do texto livre ao DAG desenhado, e dali para a revisao da missao', async () => {
    goTo('?new=1')
    renderAppWithPlanning({
      loadCompileReport: async () => makeCompileReport('warning'),
      loadProviders: async () => PROVIDERS,
      loadRuns: async () => [],
    })

    await screen.findByRole('main', { name: 'Nova missão' })
    fireEvent.change(screen.getByLabelText(/o que você quer que seja feito/i), {
      target: { value: 'quero um relatório de estoque por depósito' },
    })
    fireEvent.change(screen.getByLabelText(/actor/i), { target: { value: 'ewaldo' } })
    fireEvent.click(screen.getByLabelText(/consome a minha assinatura/i))
    fireEvent.click(screen.getByTestId('plan-mission'))

    expect(await screen.findByRole('main', { name: 'Rascunho da missão' })).toBeTruthy()
    fireEvent.click(screen.getByTestId('draft-review'))

    expect(await screen.findByRole('main', { name: 'Missão compilada' })).toBeTruthy()
    await waitFor(() => expect(window.location.search).toContain('mission='))
  })

  it('voltar ao projeto sai da tela e recarrega a Home', async () => {
    goTo('?new=1')
    renderAppWithPlanning({ loadProjectHome: async () => makeIdleProjectHome() })

    await screen.findByRole('main', { name: 'Nova missão' })
    fireEvent.click(screen.getByTestId('plan-cancel'))

    expect(await screen.findByRole('main', { name: 'Projeto' })).toBeTruthy()
    expect(window.location.search).not.toContain('new=')
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

  it('a revisão do plano abre junto da missão, com o caminho do YAML à vista', async () => {
    goTo('?mission=DA-BPM-021')
    renderMissionScreen()

    await screen.findByRole('main', { name: 'Missão compilada' })
    expect(await screen.findByRole('region', { name: 'Canvas do DAG' })).toBeTruthy()
    expect((await screen.findByTestId('plan-file')).textContent).toBe(MISSION_FILE)
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

describe('revisar, aprovar e executar num ato só', () => {
  it('aprova antes de iniciar e a tela vai sozinha para o DAG vivo', async () => {
    goTo('?mission=DA-BPM-021')
    const ordem: string[] = []
    const approve = vi.fn(async () => {
      ordem.push('approve')
    })
    const start = vi.fn(async () => {
      ordem.push('start')
      return '01J8ZC0X0000000000000000AA'
    })
    renderMissionScreen({ approve, start })

    await screen.findByRole('main', { name: 'Missão compilada' })
    fireEvent.change(screen.getByLabelText(/actor/i), { target: { value: 'ewaldo' } })
    fireEvent.change(screen.getByLabelText(/nota da aprovação/i), {
      target: { value: 'plano revisado nó a nó' },
    })
    fireEvent.click(screen.getByTestId('approve-and-start'))

    // O DAG vivo assume a tela sem nenhum clique a mais: os contadores do run só existem lá.
    expect(await screen.findByTestId('counter-RUNNING')).toBeTruthy()
    expect(screen.queryByRole('main', { name: 'Missão compilada' })).toBeNull()
    await waitFor(() => expect(window.location.search).toContain('run='))
    // Duas chamadas, nesta ordem — e a aprovação carrega quem aprovou.
    expect(ordem).toEqual(['approve', 'start'])
    // A aprovacao carrega quem aprovou E qual plano foi inspecionado: o control plane recusa
    // se o arquivo tiver mudado desde a revisao.
    expect(approve).toHaveBeenCalledWith('DA-BPM-021', {
      actor: 'ewaldo',
      note: 'plano revisado nó a nó',
      specHash: REPORT_SPEC_HASH,
    })
    expect(start).toHaveBeenCalledWith({
      missionId: 'DA-BPM-021',
      acceptWarnings: false,
      specHash: REPORT_SPEC_HASH,
      actor: 'ewaldo',
    })
  })

  it('clique duplo em aprovar e executar não cria dois runs', async () => {
    goTo('?mission=DA-BPM-021')
    // A aprovação demora: e é justamente na janela entre os dois cliques que nasceria o
    // segundo run.
    const approve = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 10)))
    const start = vi.fn(async () => '01J8ZC0X0000000000000000AA')
    renderMissionScreen({ approve, start })

    await screen.findByRole('main', { name: 'Missão compilada' })
    fireEvent.change(screen.getByLabelText(/actor/i), { target: { value: 'ewaldo' } })
    const button = screen.getByTestId('approve-and-start')
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)

    expect(await screen.findByTestId('counter-RUNNING')).toBeTruthy()
    expect(approve).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('partida que falhou não desfaz a aprovação já registrada, e destrava a tela', async () => {
    goTo('?mission=DA-BPM-021')
    const approve = vi.fn(async () => {})
    const start = vi.fn(async (): Promise<string> => {
      throw new ApiError(400, JSON.stringify({ error: { code: 'WARNINGS_NOT_ACCEPTED' } }))
    })
    renderMissionScreen({ approve, start })

    await screen.findByRole('main', { name: 'Missão compilada' })
    fireEvent.change(screen.getByLabelText(/actor/i), { target: { value: 'ewaldo' } })
    fireEvent.click(screen.getByTestId('approve-and-start'))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('WARNINGS_NOT_ACCEPTED'),
    )
    // A missão continua APPROVED (o ato humano aconteceu) e a partida volta a ser possível
    // pelo caminho de sempre — sem pedir a mesma aprovação de novo.
    expect(screen.getByTestId('mission-status').textContent).toContain('APPROVED')
    expect(screen.queryByTestId('approve-and-start')).toBeNull()
    await waitFor(() =>
      expect(screen.getByTestId('start-mission').hasAttribute('disabled')).toBe(false),
    )
    expect(approve).toHaveBeenCalledTimes(1)
  })

  it('nada é aprovado nem executado sem o ato humano', async () => {
    goTo('?mission=DA-BPM-021')
    const approve = vi.fn(async () => {})
    const start = vi.fn(async () => '01J8ZC0X0000000000000000AA')
    renderMissionScreen({ approve, start })

    await screen.findByRole('main', { name: 'Missão compilada' })
    expect(await screen.findByRole('region', { name: 'Canvas do DAG' })).toBeTruthy()
    // Congelar o plano para revisão não aprova e não parte: o rascunho é só geometria.
    expect(approve).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(screen.getByTestId('mission-status').textContent).toContain('DRAFT')
    // E sem `actor` o ato sequer está disponível.
    expect(screen.getByTestId('approve-and-start').hasAttribute('disabled')).toBe(true)
  })
})

/**
 * Os tres achados que bloquearam U16 na revisao independente. Os dois primeiros sao de
 * AUTORIDADE: aprovar um plano que o humano nao inspecionou.
 */
describe('aprovacao so vale para o plano que foi inspecionado', () => {
  it('run APPROVED de OUTRA versao do plano nao faz a missao nascer aprovada', async () => {
    goTo('?mission=DA-BPM-021')
    renderApp({
      loadCompileReport: async () => makeCompileReport('clean'),
      loadProviders: async () => PROVIDERS,
      // Aprovacao antiga, de um plano que nao e este.
      loadRuns: async () => [approvedRun('DA-BPM-021', 'sha256:versao-antiga')],
    })
    await screen.findByRole('main', { name: 'Missão compilada' })

    // Herdar a aprovacao liberaria executar um plano que ninguem viu.
    expect(screen.getByTestId('mission-status').textContent).not.toContain('APPROVED')
  })

  it('a aprovacao declara QUAL plano foi inspecionado, para o control plane poder recusar', async () => {
    goTo('?mission=DA-BPM-021')
    const approve = vi.fn(async () => undefined)
    renderApp({
      loadCompileReport: async () => makeCompileReport('clean'),
      loadProviders: async () => PROVIDERS,
      loadRuns: async () => [],
      approve,
    })
    await screen.findByRole('main', { name: 'Missão compilada' })

    fireEvent.change(screen.getByLabelText(/actor/i), { target: { value: 'Ewaldo' } })
    fireEvent.click(screen.getByTestId('approve-and-start'))

    // Conferir no cliente antes de chamar so encolheria a janela; quem fecha e o servidor,
    // recusando na mesma transacao em que aprovaria.
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith(
        'DA-BPM-021',
        expect.objectContaining({ specHash: REPORT_SPEC_HASH }),
      ),
    )
  })

  it('recusa do control plane por plano mudado vira mensagem, e nada e executado', async () => {
    goTo('?mission=DA-BPM-021')
    const start = vi.fn(async () => 'run-nao-deveria')
    renderApp({
      loadCompileReport: async () => makeCompileReport('clean'),
      loadProviders: async () => PROVIDERS,
      loadRuns: async () => [],
      approve: async () => {
        throw new Error('o arquivo da missao mudou depois do plano inspecionado')
      },
      start,
    })
    await screen.findByRole('main', { name: 'Missão compilada' })

    fireEvent.change(screen.getByLabelText(/actor/i), { target: { value: 'Ewaldo' } })
    fireEvent.click(screen.getByTestId('approve-and-start'))

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(start).not.toHaveBeenCalled()
  })

  it('CONTROLE: com o YAML intacto, aprovar de fato aprova', async () => {
    // Sem este controle o teste acima passaria vazio: bastaria o botao nunca disparar.
    goTo('?mission=DA-BPM-021')
    const approve = vi.fn(async () => undefined)
    renderApp({
      loadCompileReport: async () => makeCompileReport('clean'),
      loadProviders: async () => PROVIDERS,
      loadRuns: async () => [],
      approve,
    })
    await screen.findByRole('main', { name: 'Missão compilada' })

    fireEvent.change(screen.getByLabelText(/actor/i), { target: { value: 'Ewaldo' } })
    fireEvent.click(screen.getByTestId('approve-and-start'))

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
  })
})
