import { stopBrowserEnvironment } from './support/environment.js'
import { clearHandoff } from './support/handoff.js'

/**
 * Rede de seguranca do desligamento. `globalSetup` ja devolve o proprio teardown; este
 * arquivo garante o encerramento mesmo quando aquele retorno nao e honrado. Derrubar duas
 * vezes e inofensivo por construcao.
 */
export default async function globalTeardown(): Promise<void> {
  await stopBrowserEnvironment()
  clearHandoff()
}
