import { watchConsole } from './support/console-guard.js'
import { settle } from './support/control-plane.js'
import {
  approveInUi,
  expectRunView,
  openMission,
  runIdOf,
  runStatus,
  startInUi,
  taskNode,
} from './support/dashboard.js'
import { expect, test } from './support/fixtures.js'

/**
 * CENARIO 6 — no caminho feliz o console fica em silencio.
 *
 * Excecao engolida, `key` duplicada, resposta fora do contrato: nada disso quebra a tela
 * na hora, e por isso passa despercebido em teste de componente. No navegador de verdade
 * aparece — e aqui vira reprovacao.
 *
 * O guarda pega quatro coisas: erro e aviso no console, excecao nao capturada, requisicao
 * que nem completou e resposta HTTP >= 400. A allowlist de ruido tolerado esta em
 * `console-guard.ts` e hoje esta VAZIA.
 */
test('caminho feliz: console limpo, sem exceção e sem requisição recusada', async ({
  page,
  env,
}) => {
  test.setTimeout(120_000)
  const guarda = watchConsole(page)

  await openMission(page, env)
  await approveInUi(page)
  await startInUi(page)
  await expectRunView(page)

  await expect(taskNode(page, 'T01')).toHaveAttribute('data-status', 'DONE', { timeout: 60_000 })
  // Abrir o detalhe entra no caminho feliz: e uma chamada a mais e um render bem diferente.
  await taskNode(page, 'T01').click()
  await expect(page.getByRole('complementary', { name: 'Detalhe da task T01' })).toBeVisible()
  await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETED', { timeout: 90_000 })

  expect(
    guarda.problems,
    `o navegador reclamou:\n${guarda.problems.map((p) => `  ${p.kind} — ${p.detail}`).join('\n')}`,
  ).toEqual([])

  await settle(env.baseURL, await runIdOf(env, env.missionRef))
})
