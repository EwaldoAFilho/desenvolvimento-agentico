import { startBrowserEnvironment, stopBrowserEnvironment } from './support/environment.js'
import { clearHandoff, HANDOFF_PATH, writeHandoff } from './support/handoff.js'

/**
 * Sobe o ambiente ANTES de qualquer teste e publica a baseURL no handoff. Se isto falhar,
 * a suite inteira falha — nenhum teste de navegador roda sem control plane no ar.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  clearHandoff()
  const environment = await startBrowserEnvironment()
  writeHandoff({
    baseURL: environment.baseURL,
    missionRef: environment.missionRef,
    largeMissionRef: environment.largeMissionRef,
    projectRoot: environment.projectRoot,
    managed: environment.managed,
    startedAt: new Date().toISOString(),
  })
  const origem = environment.managed ? environment.projectRoot : 'control plane externo'
  console.log(`[browser] ${environment.baseURL} sobre ${origem} (handoff: ${HANDOFF_PATH})`)
  return async (): Promise<void> => {
    await stopBrowserEnvironment()
    clearHandoff()
  }
}
