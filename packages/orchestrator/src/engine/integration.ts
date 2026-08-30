import type { Attempt, IntegrationResult, Integrator } from '@agentic/domain'

/**
 * Modo `shared`: nao ha branch por tentativa para integrar — o commit da tentativa ja esta
 * na unica arvore. Consolidar aqui e reconhecer o commit que NOS criamos, nunca presumir.
 */
export class SharedTreeIntegrator implements Integrator {
  integrate(attempt: Attempt): Promise<IntegrationResult> {
    const commit = attempt.observation?.commit
    if (commit === undefined) {
      return Promise.resolve({ status: 'SKIPPED', detail: 'tentativa sem commit observado' })
    }
    return Promise.resolve({
      status: 'MERGED',
      commit: { sha: commit, branch: attempt.workspace.branch },
      detail: 'arvore compartilhada: commit da tentativa ja esta na branch corrente',
    })
  }
}
