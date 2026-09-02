import * as vscode from 'vscode'
import { registerCommands } from './vscode/commands.js'
import { HomePanel } from './vscode/home-panel.js'
import { AgenticHost } from './vscode/host.js'
import { AgenticLog } from './vscode/log.js'
import { MissionsTreeProvider } from './vscode/missions-view.js'
import { StatusTreeProvider } from './vscode/status-view.js'

/**
 * Desenvolvimento Agentico para VS Code — a casca.
 *
 *   VS Code Extension  ->  AgenticHost (cliente/servico)  ->  Control Plane (processo)  ->  Orchestrator
 *
 * A extensao nao contem o orquestrador: detecta o projeto, descobre ou sobe o control plane
 * (um por `repoRoot`, I14), le por HTTP e desenha. O core continua independente do editor.
 */
let host: AgenticHost | undefined

/** API devolvida por `activate`: o teste de integracao (VS Code real) le o estado por aqui. */
export interface AgenticExtensionApi {
  readonly host: AgenticHost
}

export async function activate(context: vscode.ExtensionContext): Promise<AgenticExtensionApi> {
  const log = new AgenticLog()
  context.subscriptions.push(log)
  host = new AgenticHost(log)
  context.subscriptions.push(host)
  const panel = new HomePanel(context, host, log)
  context.subscriptions.push(panel)

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('agentic.status', new StatusTreeProvider(host)),
    vscode.window.registerTreeDataProvider('agentic.missions', new MissionsTreeProvider(host)),
  )
  registerCommands(context, host, panel, log)
  log.info('extensao ativada')
  await host.initialize()
  return { host }
}

export async function deactivate(): Promise<void> {
  await host?.shutdown()
  host = undefined
}
