import { listRuns, settle } from './support/control-plane.js'
import {
  ACTOR,
  approveInUi,
  expectRunView,
  openMission,
  runIdOf,
  runStatus,
  startButton,
} from './support/dashboard.js'
import { expect, test } from './support/fixtures.js'

/**
 * CENARIO 2 — START MISSION como ATO, nao como enfeite.
 *
 * O botao e a unica operacao de escrita da tela inicial e nao existe "desfazer": dois runs
 * do mesmo spec, criados por um clique nervoso, custariam duas cadeias de worktree e um
 * banco confuso. Aqui a idempotencia e verificada onde ela pode falhar de verdade — no
 * navegador, com latencia — e conferida CONTANDO os runs pela API.
 */
test('START MISSION: um clique inicia, dois cliques não criam dois runs', async ({ page, env }) => {
  test.setTimeout(120_000)
  const runsOf = async (): Promise<number> =>
    (await listRuns(env.baseURL)).filter((run) => run.missionId === env.missionRef).length

  const antes = await runsOf()
  await openMission(page, env)

  /**
   * Latencia deliberada no POST. Sem ela a resposta volta em milissegundos e o teste
   * passaria por sorte: a janela entre os dois cliques nem existiria. O pedido continua
   * indo para o control plane REAL — o que muda e so quando a resposta chega.
   */
  const tentativas: string[] = []
  await page.route('**/api/runs', async (route) => {
    const request = route.request()
    if (request.method() !== 'POST') {
      await route.continue()
      return
    }
    tentativas.push(request.url())
    await new Promise((done) => setTimeout(done, 1200))
    await route.continue()
  })

  await test.step('missão não aprovada não deixa iniciar', async () => {
    await expect(page.getByTestId('mission-status')).toContainText('DRAFT')
    await expect(startButton(page)).toBeDisabled()
    await expect(page.getByText('START MISSION exige missão APPROVED.')).toBeVisible()
    // Clicar assim mesmo nao pode disparar nada: a recusa e da tela, nao do servidor.
    await startButton(page).click({ force: true })
    expect(tentativas, 'missão em DRAFT chamou POST /api/runs').toHaveLength(0)
  })

  await approveInUi(page, ACTOR)
  const aposAprovar = await runsOf()
  expect(aposAprovar, 'aprovar cria o run em APPROVED').toBe(antes + 1)

  await test.step('o botão diz START antes de partir', async () => {
    await expect(startButton(page)).toBeEnabled()
    await expect(startButton(page)).toHaveText('START MISSION')
    await expect(startButton(page)).toHaveAttribute('data-phase', 'idle')
    await expect(page.getByTestId('start-phase')).toHaveText('pronta para partir')
  })

  await test.step('clique duplo: o botão passa a Starting… e o POST sai uma vez só', async () => {
    await startButton(page).dblclick()
    await expect(startButton(page)).toHaveAttribute('data-phase', 'starting')
    await expect(startButton(page)).toHaveText('iniciando…')
    await expect(startButton(page)).toHaveAttribute('aria-busy', 'true')
    await expect(startButton(page)).toBeDisabled()
    await expect(page.getByTestId('start-phase')).toContainText('iniciando o run')
  })

  await test.step('a partida entrega a tela ao run — e não há dois botões de partida', async () => {
    await expectRunView(page)
    await expect(runStatus(page)).toHaveAttribute('data-status', 'RUNNING')
    await expect(startButton(page)).toHaveCount(0)
  })

  expect(tentativas, `POST /api/runs saiu ${tentativas.length} vez(es)`).toHaveLength(1)
  expect(await runsOf(), 'o clique duplo criou um run a mais').toBe(aposAprovar)

  await page.unroute('**/api/runs')
  await settle(env.baseURL, await runIdOf(env, env.missionRef))
})
