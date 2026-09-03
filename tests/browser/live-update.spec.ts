import { settle } from './support/control-plane.js'
import {
  approveInUi,
  expectRunView,
  openMission,
  runIdOf,
  startInUi,
  taskNode,
} from './support/dashboard.js'
import { expect, test } from './support/fixtures.js'
import { installStatusTimeline, statusTimeline } from './support/page-script.js'

/** Dependencias de T03 na missao de exemplo. */
const DEPENDENCIAS = ['T01', 'T02'] as const
const DEPENDENTE = 'T03'

/**
 * CENARIO 3 — tempo real de verdade: o dependente acende sem recarregar nada.
 *
 * "Ao concluir uma task, os dependentes que ficarem READY acendem imediatamente — e o
 * momento mais informativo da tela e o que prova o DAG funcionando" (DASHBOARD 6). A
 * armadilha e provar isso com um refetch disfarçado: bastaria o dashboard pedir o snapshot
 * de novo e a tela ficaria certa pelo motivo errado.
 *
 * Aqui as duas metades sao verificadas juntas: o DOM mudou (linha do tempo do
 * `MutationObserver`, que enxerga estados de milissegundos que sondagem perderia) E o
 * snapshot foi pedido UMA vez — a inicial. Depois disso, so SSE.
 */
test('tempo real: o dependente vira READY sem refetch do snapshot', async ({ page, env }) => {
  test.setTimeout(120_000)
  await installStatusTimeline(page)

  const chamadas: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) chamadas.push(`${request.method()} ${url.pathname}`)
  })

  await openMission(page, env)
  await approveInUi(page)
  // A tela da missao ja desenha o DAG do RASCUNHO (PlanReview pede o snapshot do run DRAFT,
  // que e o mesmo run que vai partir). O que este teste mede e a tela do RUN: a contagem
  // comeca no START.
  chamadas.length = 0
  await startInUi(page)
  await expectRunView(page)

  // Espera pela tela, nao pelo banco: o teste so segue quando o DOM ja mostra o dependente
  // fora de PENDING e as duas dependencias concluidas.
  for (const id of DEPENDENCIAS) {
    await expect(taskNode(page, id)).toHaveAttribute('data-status', 'DONE', { timeout: 60_000 })
  }
  await expect(taskNode(page, DEPENDENTE)).not.toHaveAttribute('data-status', 'PENDING', {
    timeout: 60_000,
  })

  const timeline = await statusTimeline(page)
  const primeiro = (taskId: string, status: string): number | undefined =>
    timeline.find((change) => change.taskId === taskId && change.status === status)?.at

  const acendeu = primeiro(DEPENDENTE, 'READY')
  expect(
    acendeu,
    `${DEPENDENTE} nunca apareceu READY no DOM: ${JSON.stringify(timeline.filter((c) => c.taskId === DEPENDENTE))}`,
  ).toBeDefined()

  for (const id of DEPENDENCIAS) {
    const concluiu = primeiro(id, 'DONE')
    expect(concluiu, `${id} nunca apareceu DONE no DOM`).toBeDefined()
    // Ordem, nao coincidencia: o dependente acendeu DEPOIS da dependencia concluir.
    expect(acendeu ?? 0).toBeGreaterThanOrEqual(concluiu ?? 0)
  }

  // O dependente comecou PENDING nesta mesma pagina — nao chegou pronto de um reload.
  expect(timeline.find((change) => change.taskId === DEPENDENTE)?.status).toBe('PENDING')

  const runId = await runIdOf(env, env.missionRef)
  const snapshots = chamadas.filter((call) => call.endsWith('/snapshot'))
  expect(snapshots, `snapshot pedido ${snapshots.length} vez(es)`).toEqual([
    `GET /api/runs/${runId}/snapshot`,
  ])
  // Nem snapshot repetido, nem polling de eventos disfarçado de tempo real.
  expect(chamadas.filter((call) => call.includes('/events'))).toEqual([])

  await settle(env.baseURL, runId)
})
