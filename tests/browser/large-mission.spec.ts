import { approveMission, settle, startRun } from './support/control-plane.js'
import {
  ACTOR,
  expectNoHorizontalScroll,
  expectRunView,
  runIdOf,
  runUrl,
  taskNode,
} from './support/dashboard.js'
import { evidence } from './support/evidence.js'
import { expect, test } from './support/fixtures.js'
import { LARGE_PHASE_COUNT, LARGE_TASK_COUNT, largeTasks } from './support/large-mission.js'
import { taskNodeRects } from './support/page-script.js'

/** Sobreposicao de 2px e antialiasing; a partir daqui um card cobre o outro. */
const TOLERANCIA_PX = 2

function seSobrepoem(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width - TOLERANCIA_PX &&
    b.x < a.x + a.width - TOLERANCIA_PX &&
    a.y < b.y + b.height - TOLERANCIA_PX &&
    b.y < a.y + a.height - TOLERANCIA_PX
  )
}

/**
 * FIXTURE MAIOR — o desenho continua legivel com 28 nos?
 *
 * A missao de exemplo tem 8 tasks e cabe na tela com folga: nenhum problema de
 * sobreposicao, de rotulo cortado ou de custo de layout aparece nesse tamanho. Uma missao
 * de verdade tem dezenas. Esta e gerada no setup, vive so no projeto-alvo temporario e
 * serve a tres perguntas objetivas: os 28 nos aparecem, nenhum cobre outro, e o layout
 * acontece em tempo de uso.
 *
 * A partida aqui e pela API, e nao pela tela: START MISSION ja tem cenario proprio
 * (`start-mission.spec.ts`) e o que esta sob teste neste arquivo e o canvas.
 */
test('o canvas continua legível com 28 nós em 4 fases', async ({ page, env }) => {
  test.setTimeout(120_000)
  const ref = env.largeMissionRef

  const compilada = await approveMission(env.baseURL, { file: ref, actor: ACTOR })
  expect(compilada.report.stats.tasks).toBe(LARGE_TASK_COUNT)
  expect(compilada.report.stats.phases).toBe(LARGE_PHASE_COUNT)
  await startRun(env.baseURL, { missionId: ref, actor: ACTOR, acceptWarnings: true })
  const runId = await runIdOf(env, ref)

  const abertura = Date.now()
  await page.goto(runUrl(env, runId))
  await expectRunView(page)
  await expect(page.locator('.task-node')).toHaveCount(LARGE_TASK_COUNT)
  const desenho = Date.now() - abertura
  // Piso generoso de desempenho: nao mede maquina, pega travamento de layout.
  expect(desenho, `${LARGE_TASK_COUNT} nós levaram ${desenho}ms para aparecer`).toBeLessThan(10_000)

  await test.step('cada nó continua se identificando', async () => {
    for (const task of [largeTasks()[0], largeTasks()[13], largeTasks()[LARGE_TASK_COUNT - 1]]) {
      if (task === undefined) throw new Error('fixture grande sem tasks')
      await expect(taskNode(page, task.id)).toContainText(task.id)
      await expect(taskNode(page, task.id)).toHaveAttribute('aria-label', /estado /)
    }
  })

  await test.step('nenhum nó cobre outro', async () => {
    const rects = await taskNodeRects(page)
    expect(rects).toHaveLength(LARGE_TASK_COUNT)
    const colisoes: string[] = []
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i]
        const b = rects[j]
        if (a !== undefined && b !== undefined && seSobrepoem(a, b)) {
          colisoes.push(`${a.taskId} sobre ${b.taskId}`)
        }
      }
    }
    expect(colisoes, `nós sobrepostos: ${colisoes.join(', ')}`).toEqual([])
  })

  await test.step('o card ainda tem tamanho de card', async () => {
    const menor = Math.min(...(await taskNodeRects(page)).map((rect) => rect.width))
    /**
     * Medida, nao meta. Com 28 nós o `fitView` desce a ~0,27x no viewport padrão e o card
     * fica com ~61px de largura: o id ainda se distingue, o titulo nao — quem quiser ler
     * precisa dar zoom (que o cenario 4 prova que sobrevive aos eventos). O piso existe
     * para que um layout MAIS denso apareça como falha, em vez de passar em silêncio.
     */
    expect(menor, `menor card com ${menor.toFixed(1)}px de largura`).toBeGreaterThan(55)
  })

  await test.step('o DAG cabe na tela sem rolagem horizontal', async () => {
    await expectNoHorizontalScroll(page)
    const canvas = await page.getByTestId('dag-canvas').boundingBox()
    if (canvas === null) throw new Error('canvas do DAG sem caixa')
    const fora = (await taskNodeRects(page)).filter(
      (rect) =>
        rect.x < canvas.x - 1 ||
        rect.y < canvas.y - 1 ||
        rect.x + rect.width > canvas.x + canvas.width + 1 ||
        rect.y + rect.height > canvas.y + canvas.height + 1,
    )
    expect(
      fora.map((rect) => rect.taskId),
      'nó fora do canvas depois do fitView',
    ).toEqual([])
  })

  await evidence(page, 'dag-28-nos')

  const fim = await settle(env.baseURL, runId)
  expect(fim.run.status).toBe('COMPLETED')
  await expect(page.locator('.task-node[data-status="DONE"]')).toHaveCount(LARGE_TASK_COUNT, {
    timeout: 30_000,
  })
})
