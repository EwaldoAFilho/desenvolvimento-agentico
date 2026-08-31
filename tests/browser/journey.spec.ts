import { runSnapshot, settle } from './support/control-plane.js'
import {
  approveInUi,
  expectRunView,
  openMission,
  runIdOf,
  runStatus,
  startInUi,
  taskNode,
} from './support/dashboard.js'
import { evidence } from './support/evidence.js'
import { expect, test } from './support/fixtures.js'
import { installStatusTimeline, statusTimeline } from './support/page-script.js'

/**
 * CENARIO 1 — a jornada inteira num navegador de verdade.
 *
 * Abrir, ver a missao compilada, dar a partida, ver o DAG se preencher, abrir o detalhe de
 * uma task e ver a missao concluir. Servidor, banco SQLite, SSE, scheduler, worktrees de
 * git e gates sao os do produto; so o agente e de mentira.
 *
 * Teste de componente React nao substitui isto: la o snapshot e um objeto literal e o
 * stream e um duble. Aqui, se o SSE nao entregar, se o build nao montar ou se o servidor
 * responder fora do contrato, o teste reprova — e e a unica suite onde isso acontece.
 */
test('jornada principal: missão compilada, partida, DAG vivo e missão concluída', async ({
  page,
  env,
}) => {
  test.setTimeout(120_000)
  await installStatusTimeline(page)

  await test.step('a missão compilada aparece com os números do compilador real', async () => {
    await openMission(page, env)
    const tela = page.getByRole('main', { name: 'Missão compilada' })
    await expect(tela).toContainText('8 tasks · 3 fases')
    await expect(tela).toContainText('0 erros')
    await expect(page.getByTestId('mission-status')).toContainText('DRAFT')
    // `ready` do painel e observado, nao otimismo: o provider in-process sabe responder.
    await expect(page.getByTestId('provider-mock')).toContainText('mock')
    await evidence(page, 'mission-ready')
    await evidence(page.getByRole('region', { name: 'Providers' }), 'provider-panel')
  })

  await test.step('aprovar é ato humano registrado e destrava a partida', async () => {
    await approveInUi(page)
    await expect(page.getByTestId('start-mission')).toBeEnabled()
  })

  await test.step('START MISSION entrega a tela ao run', async () => {
    await startInUi(page)
    await expectRunView(page)
    await expect(runStatus(page)).toHaveAttribute('data-status', 'RUNNING')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(env.missionRef)
  })

  const runId = await runIdOf(env, env.missionRef)

  await test.step('os nós mudam de estado sozinhos', async () => {
    // Um nó em RUNNING prova o despacho; T01 em DONE prova o ciclo inteiro (agente, gate,
    // revisao e integracao) chegando na tela.
    await expect(page.locator('.task-node[data-status="RUNNING"]').first()).toBeVisible()
    await evidence(page, 'mission-running')
    await expect(taskNode(page, 'T01')).toHaveAttribute('data-status', 'DONE', { timeout: 60_000 })
    // T03 depende de T01 e T02: sair de PENDING e o DAG funcionando, nao a tela adivinhando.
    await expect(taskNode(page, 'T03')).not.toHaveAttribute('data-status', 'PENDING', {
      timeout: 60_000,
    })
  })

  await test.step('o detalhe da task abre com o que o control plane mediu', async () => {
    await taskNode(page, 'T01').click()
    const detail = page.getByRole('complementary', { name: 'Detalhe da task T01' })
    await expect(detail).toBeVisible()
    await expect(detail.getByTestId('summary-phase')).toHaveText('base')
    await expect(detail.getByTestId('summary-executor')).toContainText('mock')
    await expect(detail.getByTestId('summary-attempt')).toContainText('1')
    await expect(detail.getByTestId('worktree-path')).toContainText('worktrees')
    await evidence(page, 'task-detail')
  })

  await test.step('a missão termina e a tela mostra o desfecho', async () => {
    await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETED', { timeout: 90_000 })
    await expect(page.getByTestId('counter-DONE')).toContainText('8 DONE')
    await evidence(page, 'mission-completed')
  })

  // O que a tela afirma tem de bater com o que o control plane guardou.
  const snapshot = await runSnapshot(env.baseURL, runId)
  expect(snapshot.run.status).toBe('COMPLETED')
  expect(snapshot.tasks.filter((task) => task.status === 'DONE')).toHaveLength(8)

  // E o caminho ate la foi VISTO no DOM, nao deduzido do banco.
  const timeline = await statusTimeline(page)
  const observed = new Set(timeline.map((change) => `${change.taskId}:${change.status}`))
  for (const task of snapshot.tasks) {
    expect(observed, `${task.id} nunca apareceu como DONE na tela`).toContain(`${task.id}:DONE`)
  }
  expect(timeline.filter((change) => change.status === 'RUNNING').length).toBeGreaterThan(0)

  await settle(env.baseURL, runId)
})
