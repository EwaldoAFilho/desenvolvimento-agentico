import type { PlanMissionCommand, RunSnapshot } from '@agentic/schemas'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  BROKEN_PLANNER,
  makePlanFailure,
  makePlanResult,
  REAL_PLANNER,
  SECOND_PLANNER,
  SIMULATED_PLANNER,
} from '../__fixtures__/planning.js'
import { makeSnapshot } from '../__fixtures__/snapshot.js'
import { ApiError, type PlanOutcome } from '../api.js'
import { installReactFlowEnv } from '../test/react-flow-env.js'
import { NewMission, type NewMissionDeps } from './NewMission.js'

installReactFlowEnv()

const noop = (): void => {}

/**
 * O planejamento e sempre de mentira aqui: nenhum teste desta suite pode acionar CLI de
 * agente nem consumir assinatura de ninguem (P17). O que se prova e a MAQUINA da tela.
 */
function renderScreen(
  deps: Partial<NewMissionDeps> = {},
  props: { readonly defaultPlannerId?: string; readonly onOpenMission?: (id: string) => void } = {},
) {
  const full: Partial<NewMissionDeps> = {
    loadPlanners: async () => [REAL_PLANNER],
    plan: async (): Promise<PlanOutcome> => ({ kind: 'planned', result: makePlanResult() }),
    loadSnapshot: async (): Promise<RunSnapshot> => makeSnapshot(),
    ...deps,
  }
  return render(
    <NewMission
      deps={full}
      onCancel={noop}
      onOpenMission={props.onOpenMission ?? noop}
      {...(props.defaultPlannerId === undefined
        ? {}
        : { defaultPlannerId: props.defaultPlannerId })}
    />,
  )
}

function fill(prompt = 'quero um relatório de estoque por depósito', actor = 'ewaldo'): void {
  fireEvent.change(screen.getByLabelText(/o que você quer que seja feito/i), {
    target: { value: prompt },
  })
  fireEvent.change(screen.getByLabelText(/actor/i), { target: { value: actor } })
}

function accept(): void {
  fireEvent.click(screen.getByLabelText(/consome a minha assinatura/i))
}

describe('de texto livre a DAG desenhado', () => {
  it('um pedido em texto livre vira rascunho desenhado sem pedir validação nem compilação', async () => {
    const plan = vi.fn(
      async (): Promise<PlanOutcome> => ({ kind: 'planned', result: makePlanResult() }),
    )
    renderScreen({ plan })

    await screen.findByLabelText(/o que você quer que seja feito/i)
    fill()
    accept()
    fireEvent.click(screen.getByTestId('plan-mission'))

    // O DAG aparece sozinho: em nenhum momento o usuario pediu para validar ou compilar.
    expect(await screen.findByRole('region', { name: 'Canvas do DAG' })).toBeTruthy()
    expect(screen.getByRole('main', { name: 'Rascunho da missão' })).toBeTruthy()
    expect(plan).toHaveBeenCalledTimes(1)
  })

  it('a tela não tem botão de validar nem de compilar — isso é trabalho do control plane', async () => {
    renderScreen()
    await screen.findByTestId('plan-mission')
    for (const button of screen.getAllByRole('button')) {
      const name = (button.getAttribute('aria-label') ?? button.textContent ?? '').toLowerCase()
      expect(name).not.toContain('validar')
      expect(name).not.toContain('compilar')
    }
  })

  it('o rascunho mostra os números do compilador, o arquivo gravado e quem propôs', async () => {
    renderScreen()
    await screen.findByTestId('plan-mission')
    fill()
    accept()
    fireEvent.click(screen.getByTestId('plan-mission'))

    const stats = await screen.findByTestId('draft-stats')
    expect(stats.textContent).toContain('17 tasks')
    expect(stats.textContent).toContain('caminho crítico')
    const origin = screen.getByTestId('draft-origin')
    expect(origin.textContent).toContain('agente-a')
    expect(origin.textContent).toContain('.mission.yaml')
    expect(origin.textContent).toContain('1 correção')
  })

  it('nada é aprovado nem executado: o rascunho espera ato humano', async () => {
    const onOpenMission = vi.fn()
    renderScreen({}, { onOpenMission })
    await screen.findByTestId('plan-mission')
    fill()
    accept()
    fireEvent.click(screen.getByTestId('plan-mission'))

    expect((await screen.findByTestId('draft-state')).textContent).toContain('RASCUNHO')
    expect(screen.getByTestId('draft-nothing-approved').textContent).toContain('ato humano')
    fireEvent.click(screen.getByTestId('draft-review'))
    expect(onOpenMission).toHaveBeenCalledWith(makePlanResult().missionId)
  })

  it('o relato do planejador aparece marcado como relato — não decide nada', async () => {
    renderScreen()
    await screen.findByTestId('plan-mission')
    fill()
    accept()
    fireEvent.click(screen.getByTestId('plan-mission'))

    const rationale = await screen.findByRole('region', { name: 'Relato do planejador' })
    expect(rationale.textContent).toContain('não decide transição de estado')
  })
})

describe('consumo de assinatura avisado ANTES de acionar', () => {
  it('o aviso está na tela antes de qualquer clique e a partida fica travada sem aceite', async () => {
    const plan = vi.fn(
      async (): Promise<PlanOutcome> => ({ kind: 'planned', result: makePlanResult() }),
    )
    renderScreen({ plan })

    const notice = await screen.findByTestId('subscription-notice')
    expect(notice.getAttribute('data-consumes')).toBe('true')
    expect(notice.textContent).toContain('consome a sua assinatura')
    // P17 dito com todas as letras: nenhuma chave de API entra nisso.
    expect(notice.textContent).toContain('Nenhuma chave de API')

    fill()
    const button = screen.getByTestId('plan-mission')
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('plan-phase').textContent).toContain('confirme o consumo')
    fireEvent.click(button)
    expect(plan).not.toHaveBeenCalled()
  })

  it('o aceite viaja explícito no comando', async () => {
    const commands: PlanMissionCommand[] = []
    const plan = vi.fn(async (command: PlanMissionCommand): Promise<PlanOutcome> => {
      commands.push(command)
      return { kind: 'planned', result: makePlanResult() }
    })
    renderScreen({ plan })
    await screen.findByTestId('plan-mission')
    fill()
    accept()
    fireEvent.click(screen.getByTestId('plan-mission'))

    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]?.acceptsSubscriptionUse).toBe(true)
    expect(commands[0]?.plannerId).toBe(REAL_PLANNER.providerId)
    expect(commands[0]?.actor).toBe('ewaldo')
  })

  it('enviar pelo teclado não pula o aviso: o atalho passa pela mesma guarda', async () => {
    const plan = vi.fn(
      async (): Promise<PlanOutcome> => ({ kind: 'planned', result: makePlanResult() }),
    )
    renderScreen({ plan })
    await screen.findByTestId('plan-mission')
    fill()

    const form = document.querySelector('.plan__form') as HTMLFormElement
    fireEvent.submit(form)
    expect(plan).not.toHaveBeenCalled()

    accept()
    fireEvent.submit(form)
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(1))
  })

  it('trocar de planejador zera o aceite — consentir por um não é consentir por outro', async () => {
    renderScreen({ loadPlanners: async () => [REAL_PLANNER, SECOND_PLANNER] })
    await screen.findByTestId('plan-mission')
    fill()
    accept()
    expect(screen.getByTestId('plan-mission').hasAttribute('disabled')).toBe(false)

    fireEvent.change(screen.getByLabelText(/quem planeja/i), {
      target: { value: REAL_PLANNER.providerId },
    })
    expect(screen.getByTestId('plan-mission').hasAttribute('disabled')).toBe(true)
  })
})

describe('fornecedor de teste não se apresenta como capaz de planejar de verdade', () => {
  it('o planejador simulado é dito simulado e não pede aceite de assinatura', async () => {
    const commands: PlanMissionCommand[] = []
    const plan = vi.fn(async (command: PlanMissionCommand): Promise<PlanOutcome> => {
      commands.push(command)
      return {
        kind: 'planned',
        result: makePlanResult({ plannerId: SIMULATED_PLANNER.providerId }),
      }
    })
    renderScreen({ loadPlanners: async () => [SIMULATED_PLANNER], plan })

    const notice = await screen.findByTestId('subscription-notice')
    expect(notice.getAttribute('data-consumes')).toBe('false')
    expect(notice.textContent).toContain('não é planejamento de verdade')
    expect(screen.queryByLabelText(/consome a minha assinatura/i)).toBeNull()

    fill()
    fireEvent.click(screen.getByTestId('plan-mission'))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]?.acceptsSubscriptionUse).toBe(false)
  })

  it('o rascunho vindo de planejador simulado avisa que não é plano de verdade', async () => {
    renderScreen({
      loadPlanners: async () => [SIMULATED_PLANNER],
      plan: async () => ({
        kind: 'planned' as const,
        result: makePlanResult({ plannerId: SIMULATED_PLANNER.providerId }),
      }),
    })
    await screen.findByTestId('plan-mission')
    fill()
    fireEvent.click(screen.getByTestId('plan-mission'))

    expect((await screen.findByTestId('draft-simulated')).textContent).toContain('simulado')
  })

  it('com um real disponível, o simulado não é o padrão do seletor', async () => {
    renderScreen({ loadPlanners: async () => [SIMULATED_PLANNER, SECOND_PLANNER] })
    const select = (await screen.findByLabelText(/quem planeja/i)) as HTMLSelectElement
    expect(select.value).toBe(SECOND_PLANNER.providerId)
  })
})

describe('escolher quem planeja, com padrão sensato', () => {
  it('com um só planejador não há o que escolher e ele fica dito na tela', async () => {
    renderScreen({ loadPlanners: async () => [REAL_PLANNER] })
    const single = await screen.findByTestId('planner-single')
    expect(single.textContent).toContain(REAL_PLANNER.providerId)
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('com mais de um, o seletor existe e lista todos', async () => {
    renderScreen({ loadPlanners: async () => [REAL_PLANNER, SECOND_PLANNER, SIMULATED_PLANNER] })
    const select = (await screen.findByLabelText(/quem planeja/i)) as HTMLSelectElement
    expect(select.options.length).toBe(3)
    // O simulado aparece na lista, e aparece como simulado.
    expect([...select.options].map((option) => option.textContent).join(' ')).toContain(
      'simulado, não planeja de verdade',
    )
  })

  it('o fornecedor padrão do projeto é o padrão quando ele também planeja', async () => {
    renderScreen(
      { loadPlanners: async () => [REAL_PLANNER, SECOND_PLANNER] },
      { defaultPlannerId: REAL_PLANNER.providerId },
    )
    const select = (await screen.findByLabelText(/quem planeja/i)) as HTMLSelectElement
    expect(select.value).toBe(REAL_PLANNER.providerId)
  })

  it('planejador com executável ausente não recebe partida — o motivo fica escrito', async () => {
    const plan = vi.fn(
      async (): Promise<PlanOutcome> => ({ kind: 'planned', result: makePlanResult() }),
    )
    renderScreen({ loadPlanners: async () => [BROKEN_PLANNER], plan })

    await screen.findByTestId('plan-mission')
    fill()
    const phase = screen.getByTestId('plan-phase')
    expect(phase.textContent).toContain('indisponível')
    expect(phase.textContent).toContain('executável ausente')
    fireEvent.click(screen.getByTestId('plan-mission'))
    expect(plan).not.toHaveBeenCalled()
  })

  it('projeto sem planejador diz o vazio com todas as letras, sem botão que enganaria', async () => {
    renderScreen({ loadPlanners: async () => [] })
    expect((await screen.findByTestId('planners-empty')).textContent).toContain(
      'nenhuma chave de API é pedida',
    )
    expect(screen.queryByTestId('plan-mission')).toBeNull()
    expect(screen.queryByText(/carregando/i)).toBeNull()
  })
})

describe('falha vira diagnóstico legível, nunca tela pendurada', () => {
  it('recusa do planejamento mostra código, motivo, onde doeu e o que fazer', async () => {
    renderScreen({
      plan: async () => ({ kind: 'refused' as const, failure: makePlanFailure() }),
    })
    await screen.findByTestId('plan-mission')
    fill()
    accept()
    fireEvent.click(screen.getByTestId('plan-mission'))

    const failure = await screen.findByTestId('plan-failure')
    expect(failure.getAttribute('data-code')).toBe('CONTRACT_REJECTED')
    expect(failure.textContent).toContain('não respeita o formato de missão')
    expect(failure.textContent).toContain('2 correções')
    expect(screen.getByTestId('plan-problems').textContent).toContain('tasks[3].objective')
    // Problema do plano inteiro nao fica com caminho vazio na tela.
    expect(screen.getByTestId('plan-problems').textContent).toContain('plano')
    expect(failure.textContent).toContain('Nenhum arquivo de missão foi gravado')
    expect(screen.queryByText(/carregando/i)).toBeNull()
  })

  it('o pedido não se perde na falha e a segunda tentativa é possível', async () => {
    let refusals = 1
    const plan = vi.fn(async (): Promise<PlanOutcome> => {
      if (refusals > 0) {
        refusals -= 1
        return { kind: 'refused', failure: makePlanFailure({ code: 'PLANNER_TIMEOUT' }) }
      }
      return { kind: 'planned', result: makePlanResult() }
    })
    renderScreen({ plan })
    await screen.findByTestId('plan-mission')
    fill('quero um relatório de estoque por depósito')
    accept()
    fireEvent.click(screen.getByTestId('plan-mission'))

    await screen.findByTestId('plan-failure')
    const prompt = screen.getByLabelText(/o que você quer que seja feito/i) as HTMLTextAreaElement
    expect(prompt.value).toBe('quero um relatório de estoque por depósito')

    fireEvent.click(screen.getByTestId('plan-mission'))
    expect(await screen.findByRole('region', { name: 'Canvas do DAG' })).toBeTruthy()
    expect(plan).toHaveBeenCalledTimes(2)
  })

  it('cada código de falha tem diagnóstico próprio, não uma frase genérica', async () => {
    renderScreen({
      plan: async () => ({
        kind: 'refused' as const,
        failure: makePlanFailure({ code: 'PLANNER_UNAVAILABLE', problems: [] }),
      }),
    })
    await screen.findByTestId('plan-mission')
    fill()
    accept()
    fireEvent.click(screen.getByTestId('plan-mission'))

    const failure = await screen.findByTestId('plan-failure')
    expect(failure.textContent).toContain('não estava disponível')
    expect(screen.queryByTestId('plan-problems')).toBeNull()
  })

  it('falha que não é diagnóstico de plano vira mensagem, e a tela continua utilizável', async () => {
    renderScreen({
      plan: async () => {
        throw new ApiError(
          501,
          JSON.stringify({
            error: {
              code: 'PLANNING_UNAVAILABLE',
              message: 'este control plane foi montado sem planejamento de missao',
            },
          }),
        )
      },
    })
    await screen.findByTestId('plan-mission')
    fill()
    accept()
    fireEvent.click(screen.getByTestId('plan-mission'))

    const error = await screen.findByTestId('plan-error')
    expect(error.textContent).toContain('PLANNING_UNAVAILABLE')
    expect(screen.getByTestId('plan-mission').hasAttribute('disabled')).toBe(false)
  })

  it('o rascunho não se perde quando o desenho do grafo falha', async () => {
    renderScreen({
      loadSnapshot: async () => {
        throw new ApiError(500, 'snapshot indisponível')
      },
    })
    await screen.findByTestId('plan-mission')
    fill()
    accept()
    fireEvent.click(screen.getByTestId('plan-mission'))

    const message = await screen.findByTestId('draft-no-graph')
    expect(message.textContent).toContain('foi gravado')
    expect(screen.getByTestId('draft-origin').textContent).toContain('.mission.yaml')
  })

  it('a espera anuncia progresso e a saída continua à mão — nunca uma tela presa', async () => {
    let release: (outcome: PlanOutcome) => void = () => {}
    const plan = vi.fn(
      () =>
        new Promise<PlanOutcome>((resolve) => {
          release = resolve
        }),
    )
    renderScreen({ plan })
    await screen.findByTestId('plan-mission')
    fill()
    accept()
    fireEvent.click(screen.getByTestId('plan-mission'))

    await waitFor(() =>
      expect(screen.getByTestId('plan-phase').textContent).toContain('planejando com'),
    )
    expect(screen.getByTestId('plan-mission').getAttribute('aria-busy')).toBe('true')
    // Sair nao e proibido, e nao e mentira: o plano corre no control plane, nao nesta tela.
    expect(screen.getByTestId('plan-phase').textContent).toContain('não cancela o plano')
    expect(screen.getByTestId('plan-cancel')).toBeTruthy()

    release({ kind: 'planned', result: makePlanResult() })
    expect(await screen.findByRole('region', { name: 'Canvas do DAG' })).toBeTruthy()
  })

  it('não saber quem planeja vira erro com ação, não tela em branco', async () => {
    let falhas = 1
    const loadPlanners = vi.fn(async () => {
      if (falhas > 0) {
        falhas -= 1
        throw new ApiError(503, 'control plane indisponível')
      }
      return [REAL_PLANNER]
    })
    renderScreen({ loadPlanners })

    expect((await screen.findByTestId('planners-error')).textContent).toContain('503')
    fireEvent.click(screen.getByTestId('planners-retry'))
    expect(await screen.findByTestId('plan-mission')).toBeTruthy()
    expect(loadPlanners).toHaveBeenCalledTimes(2)
  })

  it('leitura que nunca responde não deixa a tela carregando para sempre', async () => {
    const pendente = new Promise<never>(() => {})
    render(
      <NewMission
        deps={{ loadPlanners: () => pendente }}
        onCancel={noop}
        onOpenMission={noop}
        readTimeoutMs={20}
      />,
    )
    expect((await screen.findByTestId('planners-error')).textContent).toContain('não respondeu')
    expect(screen.getByTestId('planners-retry')).toBeTruthy()
  })
})

describe('idempotência do pedido', () => {
  it('clique duplo não pede dois planos', async () => {
    const plan = vi.fn(
      async (): Promise<PlanOutcome> => ({ kind: 'planned', result: makePlanResult() }),
    )
    renderScreen({ plan })
    await screen.findByTestId('plan-mission')
    fill()
    accept()

    const button = screen.getByTestId('plan-mission')
    fireEvent.click(button)
    fireEvent.click(button)

    await screen.findByRole('region', { name: 'Canvas do DAG' })
    expect(plan).toHaveBeenCalledTimes(1)
  })
})
