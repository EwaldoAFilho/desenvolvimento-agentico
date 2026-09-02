import * as vscode from 'vscode'
import {
  GIT_SCHEME,
  GitContentProvider,
  type OpenDiffArgs,
  openDiff,
  openPath,
} from './git-content.js'
import type { HomePanel } from './home-panel.js'
import type { AgenticHost } from './host.js'
import type { AgenticLog } from './log.js'

/** Todos os comandos da extensao, num lugar so. Cada um e uma acao sobre o host. */
export function registerCommands(
  context: vscode.ExtensionContext,
  host: AgenticHost,
  panel: HomePanel,
  log: AgenticLog,
): void {
  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler))
  }
  register('agentic.start', () => host.lifecycle('start'))
  register('agentic.stop', () => host.lifecycle('stop'))
  register('agentic.restart', () => host.lifecycle('restart'))
  register('agentic.refresh', async () => {
    await host.detect()
    await host.refresh({ data: true })
  })
  register('agentic.open', () => panel.open())
  register('agentic.showLog', () => log.show())
  register('agentic.openMission', (file) => {
    if (typeof file === 'string') panel.open(file)
    else panel.open()
  })
  register('agentic.openMissionFile', (arg) => {
    const file =
      typeof arg === 'string' ? arg : (arg as { readonly file?: string } | undefined)?.file
    const repoRoot = host.project?.repoRoot
    if (file !== undefined && repoRoot !== undefined) return openPath(repoRoot, file)
    return undefined
  })
  register('agentic.openFile', (path) => {
    const repoRoot = host.project?.repoRoot
    if (typeof path === 'string' && repoRoot !== undefined) return openPath(repoRoot, path)
    return undefined
  })
  register('agentic.openDiff', (args) => {
    const repoRoot = host.project?.repoRoot
    const input = args as Partial<OpenDiffArgs> | undefined
    if (
      repoRoot === undefined ||
      input?.path === undefined ||
      input.base === undefined ||
      input.head === undefined
    ) {
      return undefined
    }
    return openDiff({
      repoRoot: input.repoRoot ?? repoRoot,
      path: input.path,
      base: input.base,
      head: input.head,
    })
  })
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider()),
  )
}
