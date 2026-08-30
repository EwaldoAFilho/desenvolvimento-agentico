import type { Attempt } from '../attempt.js'
import type { IntegrationResult } from '../integration.js'

/** Conflito nao e excecao: e `FailureCode.INTEGRATION_CONFLICT`, com retry possivel. */
export interface Integrator {
  integrate(attempt: Attempt): Promise<IntegrationResult>
}
