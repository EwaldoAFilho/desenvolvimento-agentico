import { test as base } from '@playwright/test'
import { type BrowserHandoff, requireHandoff } from './handoff.js'
import { resetTargetProject } from './project.js'

/**
 * `test` desta suite: entrega o ambiente ja publicado pelo global setup e devolve o
 * projeto-alvo ao estado inicial ANTES de cada cenario.
 *
 * Cada cenario precisa de um run proprio da missao de exemplo — e um run so e comparavel
 * com outro se partir do mesmo lugar. Ler o handoff aqui, e nao no topo do arquivo,
 * continua sendo obrigatorio: a coleta dos testes acontece antes do global setup.
 */
export const test = base.extend<{ env: BrowserHandoff }>({
  // biome-ignore lint/correctness/noEmptyPattern: o Playwright exige destructuring no primeiro argumento da fixture, mesmo quando ela nao depende de nenhuma outra.
  env: async ({}, use) => {
    const env = requireHandoff()
    await resetTargetProject(env.projectRoot)
    await use(env)
  },
})

export { expect } from '@playwright/test'
