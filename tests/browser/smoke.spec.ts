import { expect, test } from '@playwright/test'
import { requireHandoff } from './support/handoff.js'

/**
 * Fumaca da INFRAESTRUTURA: navegador de verdade, servidor de verdade, banco de verdade.
 * O que a tela mostra aqui (id da missao, 8 tasks, 3 fases, o painel de providers) so
 * existe se o SPA montou e chamou a API do control plane — teste de componente React nao
 * prova nada disso.
 *
 * O handoff e lido DENTRO do teste, e nao no topo do arquivo: a coleta dos testes acontece
 * antes do global setup.
 */
test('o dashboard monta em Chromium contra o control plane real', async ({ page }) => {
  const environment = requireHandoff()
  const url = `${environment.baseURL}/?mission=${encodeURIComponent(environment.missionRef)}`

  // Sem servidor no ar isto ja reprova aqui, com ERR_CONNECTION_REFUSED.
  const response = await page.goto(url)
  expect(response?.status(), `GET ${url}`).toBe(200)

  const tela = page.getByRole('main', { name: 'Missão compilada' })
  await expect(tela).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(environment.missionRef)
  // Numeros do compilador real sobre o YAML do fixture, nao de um mock de front.
  await expect(tela).toContainText('8 tasks · 3 fases')
  await expect(tela).toContainText('0 erros')
  await expect(page.getByTestId('provider-mock')).toBeVisible()

  // O servidor tem uma pagina de fallback para `dist` ausente; ela nao pode passar por SPA.
  await expect(page.locator('body')).not.toContainText('Dashboard nao compilado')

  const health = await page.request.get(`${environment.baseURL}/api/health`)
  expect(health.status()).toBe(200)
  const body = (await health.json()) as { status: string; repoRoot: string }
  expect(body.status).toBe('ok')
  if (environment.projectRoot !== undefined) {
    // Prova que a pagina fala com o control plane DESTA suite, e nao com outro no ar.
    expect(body.repoRoot).toBe(environment.projectRoot)
  }
})
