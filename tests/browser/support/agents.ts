import { pass, review, type StepFn } from '../../e2e/support/agents.js'
import { ENTREGAS } from '../../e2e/support/entregas.js'
import { LARGE_DELIVERIES } from './large-mission.js'

/**
 * O agente de mentira desta suite. Mesmo `MockAgentProvider` do E2E, mesmo roteiro por
 * task — reusado de `tests/e2e/support/` de proposito: o que a EXEMPLO-001 entrega e um
 * fato so, e duplica-lo aqui garantiria que as duas copias divergissem.
 *
 * Nenhuma CLI real e construida, nenhuma quota e consumida (a guarda esta em
 * `assertZeroQuota`).
 */

/**
 * Quanto tempo o agente "trabalha" antes de terminar. O E2E usa 40ms porque so precisa que
 * duas tentativas se sobreponham; aqui o valor e maior DE PROPOSITO: o teste de navegador
 * precisa que RUNNING, REVIEW e a virada do dependente para READY existam por tempo
 * suficiente para serem observados na tela. Com o agente instantaneo o run inteiro caberia
 * entre dois frames e o dashboard nunca seria testado de verdade.
 */
export const BROWSER_EXECUTE_DELAY_MS = 600
export const BROWSER_REVIEW_DELAY_MS = 250

/** Entregas de todas as missoes da suite, por task. */
export const DELIVERIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  ...ENTREGAS,
  ...LARGE_DELIVERIES,
}

export const browserStep: StepFn = (context) => {
  if (context.kind === 'review') {
    return { ...review('PASS'), delayMs: BROWSER_REVIEW_DELAY_MS }
  }
  const files = DELIVERIES[context.taskId] ?? {}
  const entregues = Object.keys(files)
  const resumo =
    entregues.length === 0
      ? `${context.taskId}: nada a entregar`
      : `${context.taskId}: ${entregues.join(', ')}`
  return pass(resumo, files, BROWSER_EXECUTE_DELAY_MS)
}
