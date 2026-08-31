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
      await taskNode(page, 'T01').click()
      await expect(page.getByRole('complementary', { name: 'Detalhe da task T01' })).toBeVisible()
      await expectNoHorizontalScroll(page)
      // As acoes de run continuam alcancaveis com o painel aberto.
      await expect(page.getByRole('button', { name: /pause/ })).toBeInViewport()

      await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETED', { timeout: 90_000 })
      await expectNoHorizontalScroll(page)
      await settle(env.baseURL, await runIdOf(env, env.missionRef))
    })
  }
})
