import type { Page } from '@playwright/test'
import { settle } from './support/control-plane.js'
import {
  approveInUi,
  expectNoHorizontalScroll,
  expectRunView,
  openMission,
  runIdOf,
  runStatus,
  startButton,
  startInUi,
  taskNode,
} from './support/dashboard.js'
import { expect, test } from './support/fixtures.js'
import { resetTargetProject } from './support/project.js'

/**
 * Desktop-first, como o produto declara. Nao ha redesign mobile aqui: 1366x768 e o menor
 * monitor de trabalho que ainda importa e 1920x1080 e o comum.
 */
const RESOLUCOES = [
  { nome: '1366x768', width: 1366, height: 768 },
  { nome: '1920x1080', width: 1920, height: 1080 },
] as const

/**
 * CENARIO 7 — a jornada inteira cabe na tela.
 *
 * "Sem exigir scroll horizontal para operar" e requisito, nao gosto: um DAG que empurra o
 * botao de partida para fora do viewport transforma a operacao em cacada. A conferencia e
 * feita em cada etapa que muda o layout — missao compilada, run vivo e detalhe aberto —
 * porque cada uma tem uma largura diferente.
 */

/**
 * "Sem scroll horizontal" nao basta: a revisao independente mediu e achou dois dos oito nos
 * renderizando ABAIXO do canvas em 1366x768. O teste passava porque afirmava a coisa errada
 * — declarava a resolucao boa sem nunca conferir se o grafo cabia nela.
 *
 * Um DAG e pan/zoom por natureza, entao o requisito honesto nao e "tudo visivel para sempre":
 * e que o enquadramento INICIAL mostre o grafo inteiro. Quem abre o dashboard precisa ver o
 * que esta acontecendo antes de aprender a arrastar o canvas.
 */
async function expectTodosOsNosDentroDoCanvas(page: Page, resolucao: string): Promise<void> {
  const canvas = page.locator('.react-flow__viewport').first()
  await expect(canvas).toBeVisible()
  const painel = await page.locator('.react-flow').first().boundingBox()
  expect(painel, `canvas sem geometria em ${resolucao}`).not.toBeNull()

  const nos = page.locator('.task-node')
  const total = await nos.count()
  expect(total, `nenhum no renderizado em ${resolucao}`).toBeGreaterThan(0)

  const fora: string[] = []
  for (let i = 0; i < total; i += 1) {
    const no = nos.nth(i)
    const caixa = await no.boundingBox()
    const id = (await no.getAttribute('data-task-id')) ?? `#${i}`
    if (caixa === null) {
      fora.push(`${id} (sem geometria)`)
      continue
    }
    const area = painel as { x: number; y: number; width: number; height: number }
    const abaixo = caixa.y + caixa.height - (area.y + area.height)
    const acima = area.y - caixa.y
    const direita = caixa.x + caixa.width - (area.x + area.width)
    const esquerda = area.x - caixa.x
    const excesso = Math.max(abaixo, acima, direita, esquerda)
    if (excesso > 1) fora.push(`${id} (${Math.round(excesso)}px fora)`)
  }

  expect(fora, `em ${resolucao} o enquadramento inicial deixa nos fora do canvas`).toEqual([])
}

test('a jornada roda em 1366x768 e em 1920x1080 sem scroll horizontal', async ({ page, env }) => {
  test.setTimeout(180_000)

  for (const resolucao of RESOLUCOES) {
    await test.step(resolucao.nome, async () => {
      // Cada volta e um run novo: o projeto-alvo volta ao inicio antes de comecar.
      await resetTargetProject(env.projectRoot)
      await page.setViewportSize({ width: resolucao.width, height: resolucao.height })

      await openMission(page, env)
      await expectNoHorizontalScroll(page)
      await approveInUi(page)
      await expect(startButton(page)).toBeInViewport()
      await expectNoHorizontalScroll(page)

      await startInUi(page)
      await expectRunView(page)
      await expectNoHorizontalScroll(page)

      // Operar com o run andando: o canvas e o painel de detalhe dividem a largura.
      await expect(taskNode(page, 'T01')).toHaveAttribute('data-status', 'DONE', {
        timeout: 60_000,
      })
      // Antes de abrir o painel: o enquadramento inicial precisa mostrar o grafo inteiro.
      await expectTodosOsNosDentroDoCanvas(page, `${resolucao.nome} sem painel`)
      await taskNode(page, 'T01').click()
      await expect(page.getByRole('complementary', { name: 'Detalhe da task T01' })).toBeVisible()
      await expectNoHorizontalScroll(page)
      // E depois: abrir o painel encolhe o canvas, e o grafo precisa reenquadrar.
      await expectTodosOsNosDentroDoCanvas(page, `${resolucao.nome} com painel aberto`)
      // As acoes de run continuam alcancaveis com o painel aberto.
      await expect(page.getByRole('button', { name: /pause/ })).toBeInViewport()

      await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETED', { timeout: 90_000 })
      await expectNoHorizontalScroll(page)
      await settle(env.baseURL, await runIdOf(env, env.missionRef))
    })
  }
})
