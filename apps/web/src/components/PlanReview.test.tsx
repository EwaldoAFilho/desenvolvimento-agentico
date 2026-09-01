import type { CompileReportDto } from '@agentic/schemas'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeDraftResult, makeDraftSnapshot, makePlanTaskDetail } from '../__fixtures__/planning.js'
import { makeCompileReport } from '../__fixtures__/snapshot.js'
import { ApiError } from '../api.js'
import { installReactFlowEnv } from '../test/react-flow-env.js'
import { PlanReview, type PlanReviewDeps } from './PlanReview.js'

installReactFlowEnv()

const noop = (): void => {}

const MISSION_FILE = '.agentic/missions/DA-BPM-021.mission.yaml'

/**
 * Toda leitura e de mentira aqui: a revisao do plano se prova sem servidor e — o que importa
 * mais — sem acionar planejador nenhum. Nenhum teste desta suite consome assinatura (P17).
 */
function renderReview(
  deps: Partial<PlanReviewDeps> = {},
  props: {
    readonly report?: CompileReportDto
    readonly missionFile?: string
    readonly onReload?: () => void
    readonly reloading?: boolean
  } = {},
) {
  const full: Partial<PlanReviewDeps> = {
    createDraft: async () => makeDraftResult(),
    loadSnapshot: async () => makeDraftSnapshot(),
    loadTaskDetail: async () => makePlanTaskDetail(),
    ...deps,
  }
  return render(
    <PlanReview
      report={props.report ?? makeCompileReport('warning')}
      missionFile={props.missionFile ?? MISSION_FILE}
      deps={full}
      onReload={props.onReload ?? noop}
      {...(props.reloading === undefined ? {} : { reloading: props.reloading })}
    />,
  )
}

function selectNode(taskId = 'T09'): void {
  fireEvent.click(screen.getByTestId(`task-node-${taskId}`))
}

describe('o plano proposto desenhado para revisao', () => {
  it('congela o plano e desenha o DAG sem o humano pedir', async () => {
    const createDraft = vi.fn(async () => makeDraftResult())
    renderReview({ createDraft })

    expect(await screen.findByRole('region', { name: 'Canvas do DAG' })).toBeTruthy()
    expect(createDraft).toHaveBeenCalledTimes(1)
    // Com o caminho do arquivo em maos, e por ele que o rascunho e pedido: o id so encontra
    // o arquivo quando o nome dele segue o id.
    expect(createDraft).toHaveBeenCalledWith({ missionPath: MISSION_FILE })
  })

  it('sem o caminho do arquivo, o rascunho e pedido pelo id da missao', async () => {
    const createDraft = vi.fn(async () => makeDraftResult())
    render(
      <PlanReview
        report={makeCompileReport('warning')}
        deps={{
          createDraft,
          loadSnapshot: async () => makeDraftSnapshot(),
          loadTaskDetail: async () => makePlanTaskDetail(),
        }}
        onReload={noop}
      />,
    )
    await screen.findByRole('region', { name: 'Canvas do DAG' })
    expect(createDraft).toHaveBeenCalledWith({ missionId: 'DA-BPM-021' })
  })

  it('o rascunho ja existente e reaproveitado: rever o plano nao cria run atras de run', async () => {
    // `alreadyExisted` e a resposta do control plane para o MESMO specHash — a idempotencia
    // e dele; o que se prova aqui e que a tela pede uma vez so por plano.
    const createDraft = vi.fn(async () => makeDraftResult(true))
    const { rerender } = renderReview({ createDraft })
    await screen.findByRole('region', { name: 'Canvas do DAG' })

    const report = makeCompileReport('warning')
    rerender(
      <PlanReview
        report={report}
        missionFile={MISSION_FILE}
        deps={{
          createDraft,
          loadSnapshot: async () => makeDraftSnapshot(),
          loadTaskDetail: async () => makePlanTaskDetail(),
        }}
        onReload={noop}
      />,
    )
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('plan-review')).toBeTruthy()
  })

  it('com ERROR nao ha plano congelado: a tela diz isso e nao pede rascunho', async () => {
    const createDraft = vi.fn(async () => makeDraftResult())
    renderReview({ createDraft }, { report: makeCompileReport('error') })

    expect(await screen.findByTestId('plan-blocked')).toBeTruthy()
    expect(createDraft).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: 'Canvas do DAG' })).toBeNull()
  })

  it('falha ao congelar vira motivo legivel, nao tela pendurada', async () => {
    renderReview({
      createDraft: async () => {
        throw new ApiError(422, JSON.stringify({ error: { code: 'MISSION_HAS_ERRORS' } }))
      },
    })

    const message = await screen.findByTestId('plan-unavailable')
    expect(message.textContent).toContain('MISSION_HAS_ERRORS')
    expect(screen.queryByTestId('plan-loading')).toBeNull()
  })

  it('o grafo que nao chega no prazo tambem termina em motivo', async () => {
    render(
      <PlanReview
        report={makeCompileReport('clean')}
        deps={{
          createDraft: async () => makeDraftResult(),
          loadSnapshot: () => new Promise(() => {}),
          loadTaskDetail: async () => makePlanTaskDetail(),
        }}
        onReload={noop}
        readTimeoutMs={20}
      />,
    )
    expect((await screen.findByTestId('plan-unavailable')).textContent).toContain('não chegou em')
  })
})

describe('clicar num no do plano', () => {
  it('mostra objetivo, dependencias, escopo, validacao, gate, risco e revisao', async () => {
    renderReview()
    await screen.findByRole('region', { name: 'Canvas do DAG' })
    expect(screen.getByTestId('plan-node-empty')).toBeTruthy()

    selectNode('T09')

    expect(await screen.findByTestId('plan-node')).toBeTruthy()
    expect(screen.getByTestId('plan-node-objective').textContent).toContain(
      'contratos de leitura de T03',
    )
    expect(screen.getByTestId('plan-node-dependencies').textContent).toBe('T05')
    expect(screen.getByTestId('plan-node-dependents').textContent).toBe('T11')
    expect(screen.getByTestId('plan-node-critical').textContent).toContain('sim')
    expect(screen.getByTestId('plan-node-scope').textContent).toBe('ui/propriedades/')
    expect(screen.getByTestId('plan-node-validation').textContent).toContain(
      'recusa gravação sem permissão',
    )
    expect(screen.getByTestId('plan-node-gate').textContent).toBe('frontend')
    expect(screen.getByTestId('plan-node-risk').textContent).toContain('alto')
    expect(screen.getByTestId('plan-node-review').textContent).toContain('registrada na tentativa')
  })

  it('o conflito que cita o no aparece no no', async () => {
    renderReview()
    await screen.findByRole('region', { name: 'Canvas do DAG' })
    selectNode('T09')

    const diagnostics = await screen.findByTestId('plan-node-diagnostics')
    expect(diagnostics.textContent).toContain('DA2001')
    expect(diagnostics.textContent).toContain('conflito de escopo')
  })

  it('detalhe que nao carrega nao apaga o que a estrutura ja sabe', async () => {
    renderReview({
      loadTaskDetail: async () => {
        throw new ApiError(404, 'task nao encontrada no run')
      },
    })
    await screen.findByRole('region', { name: 'Canvas do DAG' })
    selectNode('T09')

    expect((await screen.findByTestId('plan-node-error')).textContent).toContain('404')
    // Dependencia, escopo e risco vem do grafo congelado: continuam na tela.
    expect(screen.getByTestId('plan-node-dependencies').textContent).toBe('T05')
    expect(screen.getByTestId('plan-node-risk').textContent).toContain('alto')
    expect(screen.getByTestId('plan-node-objective').textContent).toContain('não lido')
  })

  it('fechar o no devolve a tela ao estado sem selecao', async () => {
    renderReview()
    await screen.findByRole('region', { name: 'Canvas do DAG' })
    selectNode('T09')
    await screen.findByTestId('plan-node')

    fireEvent.click(screen.getByRole('button', { name: 'fechar o nó T09' }))
    expect(screen.getByTestId('plan-node-empty')).toBeTruthy()
  })
})

describe('ajuste minimo sem editor visual de grafo', () => {
  it('o caminho do YAML fica a vista, com o comando do editor pronto para copiar', async () => {
    renderReview()
    expect((await screen.findByTestId('plan-file')).textContent).toBe(MISSION_FILE)
    expect(
      screen.getByRole('button', { name: `copiar comando do editor: code ${MISSION_FILE}` }),
    ).toBeTruthy()
  })

  it('reler o plano do disco e uma acao da tela, e ela diz que nada e gravado aqui', async () => {
    const onReload = vi.fn()
    renderReview({}, { onReload })

    fireEvent.click(await screen.findByTestId('plan-reload'))
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('plan-reload-phase').textContent).toContain(
      'quem escreve missão é o control plane',
    )
  })

  it('sem caminho informado a tela diz isso em vez de inventar um', async () => {
    render(
      <PlanReview
        report={makeCompileReport('clean')}
        deps={{
          createDraft: async () => makeDraftResult(),
          loadSnapshot: async () => makeDraftSnapshot(),
          loadTaskDetail: async () => makePlanTaskDetail(),
        }}
        onReload={noop}
      />,
    )
    expect(await screen.findByTestId('plan-file-unknown')).toBeTruthy()
    expect(screen.queryByTestId('plan-file')).toBeNull()
  })

  it('enquanto relê, a acao fica ocupada e o estado e anunciado em texto', async () => {
    renderReview({}, { reloading: true })
    const button = await screen.findByTestId('plan-reload')
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId('plan-reload-phase').getAttribute('role')).toBe('status')
    expect(screen.getByTestId('plan-reload-phase').textContent).toContain('recompilando')
  })
})
