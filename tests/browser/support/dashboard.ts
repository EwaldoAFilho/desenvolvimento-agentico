import { expect, type Locator, type Page } from '@playwright/test'
import { latestRun } from './control-plane.js'
import type { BrowserHandoff } from './handoff.js'
import { documentOverflow } from './page-script.js'

/** Aprovar e iniciar sao atos humanos REGISTRADOS: a suite assina com um nome proprio. */
export const ACTOR = 'suite-navegador'

export function missionUrl(env: BrowserHandoff, ref: string = env.missionRef): string {
  return `${env.baseURL}/?mission=${encodeURIComponent(ref)}`
}

export function runUrl(env: BrowserHandoff, runId: string): string {
  return `${env.baseURL}/?run=${encodeURIComponent(runId)}`
}

/** Tela de missao compilada, servida pelo build de `apps/web` que o control plane publica. */
export async function openMission(
  page: Page,
  env: BrowserHandoff,
  ref: string = env.missionRef,
): Promise<void> {
  const response = await page.goto(missionUrl(env, ref))
  expect(response?.status(), `GET ${missionUrl(env, ref)}`).toBe(200)
  await expect(page.getByRole('main', { name: 'Missão compilada' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(ref)
}

export function startButton(page: Page): Locator {
  return page.getByTestId('start-mission')
}

/**
 * Aprovacao pela UI. Idempotente de proposito: o control plane e o mesmo para a suite
 * inteira, entao a missao pode chegar aqui ja aprovada por um teste anterior.
 */
export async function approveInUi(page: Page, actor: string = ACTOR): Promise<void> {
  await page.getByLabel('actor (quem está aprovando/iniciando)').fill(actor)
  const approve = page.getByRole('button', { name: 'aprovar missão' })
  if ((await approve.count()) > 0) {
    await approve.click()
    await expect(approve).toHaveCount(0)
  }
  await expect(page.getByTestId('mission-status')).toContainText('APPROVED')
}

/** START MISSION: UM clique. Quem descobre as tasks READY e o orquestrador. */
export async function startInUi(page: Page): Promise<void> {
  await expect(startButton(page)).toBeEnabled()
  await startButton(page).click()
  const confirm = page.getByTestId('confirm-start')
  if ((await confirm.count()) > 0) await confirm.click()
}

/** O dashboard do run assumiu a tela. */
export async function expectRunView(page: Page): Promise<void> {
  await expect(page.locator('.run-header')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Canvas do DAG' })).toBeVisible()
}

export function taskNode(page: Page, taskId: string): Locator {
  return page.getByTestId(`task-node-${taskId}`)
}

/** Nó do react-flow (o container focavel), nao o card. */
export function flowNode(page: Page, taskId: string): Locator {
  return page.locator(`.react-flow__node-task[data-id="${taskId}"]`)
}

export function runStatus(page: Page): Locator {
  return page.locator('.run-header__status')
}

export async function runIdOf(env: BrowserHandoff, missionId: string): Promise<string> {
  const run = await latestRun(env.baseURL, missionId)
  if (run === undefined) throw new Error(`nenhum run de ${missionId} no control plane`)
  return run.id
}

/** Transform do viewport do react-flow: e nele que pan e zoom vivem. */
export async function viewportTransform(page: Page): Promise<string> {
  return page.locator('.react-flow__viewport').evaluate((element) => element.style.transform)
}

/** Operar sem rolagem horizontal e requisito de tela desktop, nao detalhe estetico. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await documentOverflow(page)
  expect(
    overflow.scrollWidth,
    `documento com ${overflow.scrollWidth}px em viewport de ${overflow.clientWidth}px`,
  ).toBeLessThanOrEqual(overflow.clientWidth)
}
