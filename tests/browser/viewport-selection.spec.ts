import { settle } from './support/control-plane.js'
import {
  approveInUi,
  expectRunView,
  openMission,
  runIdOf,
  startInUi,
  taskNode,
  viewportTransform,
} from './support/dashboard.js'
import { expect, test } from './support/fixtures.js'
import { installStatusTimeline, statusTimeline, taskNodeRects } from './support/page-script.js'

const SELECIONADA = 'T05'

/** Ponto do canvas que nao cai sobre nenhum nó — arrastar em cima de um nó nao faz pan. */
async function pontoVazio(
  page: import('@playwright/test').Page,
): Promise<{ x: number; y: number }> {
  const canvas = await page.getByTestId('dag-canvas').boundingBox()
  if (canvas === null) throw new Error('canvas do DAG sem caixa')
  const rects = await taskNodeRects(page)
  const margem = 12
  for (let y = canvas.y + canvas.height - 40; y > canvas.y + margem; y -= 16) {
    for (let x = canvas.x + canvas.width - 40; x > canvas.x + margem; x -= 16) {
      const ocupado = rects.some(
        (rect) =>
          x >= rect.x - margem &&
          x <= rect.x + rect.width + margem &&
          y >= rect.y - margem &&
          y <= rect.y + rect.height + margem,
      )
      if (!ocupado) return { x, y }
    }
  }
  throw new Error('nenhum ponto livre no canvas para arrastar')
}

/**
 * CENARIO 4 — a tela nao pode puxar o tapete de quem esta olhando.
 *
 * "Posicao dos nos e estavel entre atualizacoes: so cor, icone e rotulo mudam"
 * (DASHBOARD 6). O modo classico de quebrar isso e refazer `fitView` a cada evento: a
 * tela fica correta e inutil, porque o operador perde o enquadramento e a selecao a cada
 * task que conclui. Aqui a selecao e o viewport sao medidos ANTES e DEPOIS de uma rajada
 * de eventos de verdade.
 */
test('viewport e seleção sobrevivem a uma rajada de eventos', async ({ page, env }) => {
  test.setTimeout(120_000)
  await installStatusTimeline(page)

  await openMission(page, env)
  await approveInUi(page)
  await startInUi(page)
  await expectRunView(page)

  await taskNode(page, SELECIONADA).click()
  const detalhe = page.getByRole('complementary', { name: `Detalhe da task ${SELECIONADA}` })
  await expect(detalhe).toBeVisible()
  await expect(taskNode(page, SELECIONADA)).toHaveClass(/task-node--picked/)

  await test.step('o operador enquadra a tela do jeito dele', async () => {
    const antes = await viewportTransform(page)
    await page.locator('.react-flow__controls-zoomin').click()
    await page.locator('.react-flow__controls-zoomin').click()
    const ponto = await pontoVazio(page)
    await page.mouse.move(ponto.x, ponto.y)
    await page.mouse.down()
    await page.mouse.move(ponto.x - 90, ponto.y - 60, { steps: 10 })
    await page.mouse.up()
    // Se o gesto nao mexeu no viewport, o resto do teste nao provaria nada.
    expect(await viewportTransform(page)).not.toBe(antes)
  })

  const enquadramento = await viewportTransform(page)
  const mudancasAntes = (await statusTimeline(page)).length

  await test.step('a rajada chega', async () => {
    // Rajada de verdade: varias tasks concluindo enquanto a tela fica parada.
    await expect(page.locator('.task-node[data-status="DONE"]')).toHaveCount(4, { timeout: 60_000 })
  })

  const mudancasDepois = (await statusTimeline(page)).length
  expect(
    mudancasDepois - mudancasAntes,
    'a rajada foi pequena demais para provar estabilidade',
  ).toBeGreaterThanOrEqual(10)

  expect(await viewportTransform(page), 'o viewport foi resetado por um evento').toBe(enquadramento)
  await expect(taskNode(page, SELECIONADA)).toHaveClass(/task-node--picked/)
  await expect(detalhe).toBeVisible()
  await expect(page.locator('aside.detail')).toHaveAttribute(
    'aria-label',
    `Detalhe da task ${SELECIONADA}`,
  )

  await settle(env.baseURL, await runIdOf(env, env.missionRef))
})
