import { settle } from './support/control-plane.js'
import {
  ACTOR,
  expectRunView,
  flowNode,
  openMission,
  runIdOf,
  runStatus,
  startButton,
  taskNode,
} from './support/dashboard.js'
import { expect, test } from './support/fixtures.js'
import { focusSignature } from './support/page-script.js'

/** Anda de Tab ate encontrar o elemento pedido, ou reprova dizendo onde parou. */
async function tabAte(
  page: import('@playwright/test').Page,
  alvo: (foco: { readonly tag: string; readonly id: string; readonly text: string }) => boolean,
  descricao: string,
  limite = 20,
): Promise<{ outlineStyle: string; outlineWidth: string }> {
  const caminho: string[] = []
  for (let passo = 0; passo < limite; passo += 1) {
    await page.keyboard.press('Tab')
    const foco = await focusSignature(page)
    caminho.push(`${foco.tag}[${foco.id}] ${foco.text}`)
    if (alvo(foco)) return { outlineStyle: foco.outlineStyle, outlineWidth: foco.outlineWidth }
  }
  throw new Error(`Tab nunca chegou em ${descricao}. Caminho:\n  ${caminho.join('\n  ')}`)
}

/**
 * CENARIO 8 — acessibilidade basica, do jeito que o produto ja se comprometeu.
 *
 * "Cor nunca e o unico diferenciador — sempre acompanha icone e rotulo textual. Um
 * daltonico e uma captura em preto e branco precisam funcionar" (DASHBOARD 3). E, do lado
 * da operacao: o que da para fazer com o mouse tem de dar para fazer com o teclado, com o
 * foco visivel e com nome acessivel em cada acao.
 *
 * Nao e auditoria WCAG completa; e o piso que o dashboard prometeu e que uma regressao
 * silenciosa derrubaria.
 */
test('teclado, foco visível, rótulo acessível e estado que não depende de cor', async ({
  page,
  env,
}) => {
  test.setTimeout(120_000)
  await openMission(page, env)

  await test.step('a tela de partida é operável pelo teclado', async () => {
    const actor = await tabAte(page, (foco) => foco.id === 'actor', 'o campo actor')
    expect(actor.outlineStyle, 'foco sem contorno visível no campo actor').not.toBe('none')

    // Aprovar exige `actor`: sem ele o botao fica desabilitado e fora da ordem de foco.
    await page.keyboard.type(ACTOR)
    const aprovar = page.getByRole('button', { name: 'aprovar missão' })
    await expect(aprovar).toBeEnabled()
    const foco = await tabAte(page, (f) => f.text.includes('aprovar missão'), 'o botão de aprovar')
    expect(foco.outlineStyle, 'foco sem contorno visível no botão aprovar').not.toBe('none')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('mission-status')).toContainText('APPROVED')
  })

  await test.step('START MISSION tem rótulo acessível e parte pelo teclado', async () => {
    await expect(startButton(page)).toBeEnabled()
    // O nome acessivel e o rotulo visivel: nao ha botao "de icone" sem nome nesta tela.
    await expect(page.getByRole('button', { name: 'START MISSION' })).toBeVisible()
    const foco = await tabAte(page, (f) => f.text.includes('START MISSION'), 'o botão START')
    expect(foco.outlineStyle, 'foco sem contorno visível no botão START').not.toBe('none')
    await page.keyboard.press('Enter')
    await expectRunView(page)
  })

  await test.step('o DAG é navegável e o nó abre pelo teclado', async () => {
    const foco = await tabAte(page, (f) => f.id === 'task-node-T01', 'o nó T01 no canvas', 30)
    expect(foco.outlineStyle, 'nó focado sem contorno visível').not.toBe('none')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('complementary', { name: 'Detalhe da task T01' })).toBeVisible()
    // Botao de icone COM nome acessivel — o unico jeito de o leitor de tela saber o que faz.
    await expect(page.getByRole('button', { name: 'fechar detalhe' })).toBeVisible()
  })

  await test.step('as ações de run têm nome acessível', async () => {
    await expect(page.getByRole('button', { name: /pause/ })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Canvas do DAG' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Providers' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Stream de eventos' })).toBeVisible()
  })

  await test.step('estado não depende só de cor', async () => {
    await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETED', { timeout: 90_000 })
    for (const id of ['T01', 'T05', 'T08']) {
      const no = taskNode(page, id)
      // Rotulo textual no card...
      await expect(no).toContainText('DONE')
      // ...e o mesmo estado no nome acessivel, para quem nao ve o card.
      await expect(no).toHaveAttribute('aria-label', /estado DONE/)
      // O icone existe, mas e `aria-hidden`: ele reforça, nao substitui o texto.
      await expect(no.locator('.task-node__icon')).toHaveAttribute('aria-hidden', 'true')
      await expect(flowNode(page, id)).toHaveAttribute('tabindex', '0')
    }
    // O contador do cabecalho tambem e texto, nao so cor.
    await expect(page.getByTestId('counter-DONE')).toContainText('8 DONE')
  })

  await settle(env.baseURL, await runIdOf(env, env.missionRef))
})
