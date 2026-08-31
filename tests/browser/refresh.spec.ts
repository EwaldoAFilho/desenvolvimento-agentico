import { runSnapshot, settle, waitForRunStatus } from './support/control-plane.js'
import {
  approveInUi,
  expectRunView,
  openMission,
  runIdOf,
  runStatus,
  runUrl,
  startInUi,
} from './support/dashboard.js'
import { expect, test } from './support/fixtures.js'
import { taskStatuses } from './support/page-script.js'

/** Estados em que a task ainda esta andando: nenhuma conferencia estavel com um deles vivo. */
const EM_VOO: readonly string[] = ['RUNNING', 'VERIFYING', 'REVIEW', 'INTEGRATING']

/**
 * CENARIO 5 — recarregar no meio do run nao pode perder o run.
 *
 * O dashboard nao guarda estado proprio: ele e projecao do estado oficial (DASHBOARD 1).
 * A prova disso e o F5 — se algo importante so existisse na memoria do React, apareceria
 * aqui. A comparacao e contra o backend, campo a campo, e nao contra o que a tela mostrava
 * antes: "reconstruido" significa igual ao control plane, nao parecido com o de antes.
 *
 * O run e PAUSADO antes da conferencia de proposito. Nao para facilitar: sem pausar, o
 * estado muda entre a leitura do DOM e a do banco e a comparacao viraria uma corrida — o
 * teste reprovaria (ou passaria) por causa do relogio, nao do produto.
 */
test('refresh no meio do run: a tela é reconstruída a partir do backend', async ({ page, env }) => {
  test.setTimeout(120_000)

  await openMission(page, env)
  await approveInUi(page)
  await startInUi(page)
  await expectRunView(page)
  const runId = await runIdOf(env, env.missionRef)

  await expect(page.locator('.task-node[data-status="DONE"]')).toHaveCount(2, { timeout: 60_000 })

  await test.step('pausar congela o run pela própria tela', async () => {
    await page.getByRole('button', { name: /pause/ }).click()
    await expect(runStatus(page)).toHaveAttribute('data-status', 'PAUSED', { timeout: 30_000 })
    await waitForRunStatus(env.baseURL, runId, ['PAUSED'], 30_000)
  })

  /**
   * Pausar impede NOVO despacho; a tentativa ja em voo termina o que comecou — e ao
   * concluir ainda destrava dependentes para READY. Assentar, portanto, e duas condicoes:
   * nenhuma task em voo (`EM_VOO`) E duas leituras seguidas iguais, para nao fotografar o
   * instante entre o DONE e o READY que ele libera.
   */
  const estavel = await test.step('esperar o run assentar', async () => {
    let anterior = ''
    for (let tentativa = 0; tentativa < 200; tentativa += 1) {
      const snapshot = await runSnapshot(env.baseURL, runId)
      const atual = JSON.stringify(snapshot.tasks.map((task) => [task.id, task.status]))
      const emVoo = snapshot.tasks.some((task) => EM_VOO.includes(task.status))
      if (!emVoo && atual === anterior) return snapshot
      anterior = atual
      await new Promise((done) => setTimeout(done, 150))
    }
    throw new Error('o run pausado nunca parou de mudar')
  })

  const oficial = Object.fromEntries(estavel.tasks.map((task) => [task.id, task.status]))

  await test.step('abrir o run pela URL reconstrói tudo', async () => {
    await page.goto(runUrl(env, runId))
    await expectRunView(page)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(env.missionRef)
    await expect(runStatus(page)).toHaveAttribute('data-status', 'PAUSED')
    expect(await taskStatuses(page)).toEqual(oficial)
  })

  await test.step('F5 no meio do run reconstrói de novo', async () => {
    await page.reload()
    await expectRunView(page)
    await expect(runStatus(page)).toHaveAttribute('data-status', 'PAUSED')
    expect(await taskStatuses(page)).toEqual(oficial)
    // Contadores tambem sao projecao: conferem com o que o banco guardou.
    const concluidas = estavel.tasks.filter((task) => task.status === 'DONE').length
    await expect(page.getByTestId('counter-DONE')).toContainText(`${concluidas} DONE`)
  })

  await test.step('abrir o dashboard sem parâmetro encontra o run vivo', async () => {
    await page.goto(`${env.baseURL}/`)
    await expectRunView(page)
    await expect(runStatus(page)).toHaveAttribute('data-status', 'PAUSED')
    expect(await taskStatuses(page)).toEqual(oficial)
  })

  await test.step('retomar volta a andar', async () => {
    await page.getByRole('button', { name: /resume/ }).click()
    await expect(runStatus(page)).toHaveAttribute('data-status', 'RUNNING', { timeout: 30_000 })
  })

  const fim = await settle(env.baseURL, runId)
  expect(fim.run.status).toBe('COMPLETED')
})
