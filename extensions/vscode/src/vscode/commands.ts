import * as vscode from 'vscode'
import {
  GIT_SCHEME,
  GitContentProvider,
  type OpenDiffArgs,
  openDiff,
  openPath,
  type PathAuthorization,
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
  /** Comandos com caminho so abrem dentro do projeto detectado (o mesmo limite do painel). */
  const scopeOf = (): { repoRoot: string; auth: PathAuthorization } | undefined => {
    const project = host.project
    if (project === undefined) return undefined
    return {
      repoRoot: project.repoRoot,
      auth: { roots: [project.repoRoot, project.projectDir], published: new Set() },
    }
  }
  register('agentic.openMissionFile', (arg) => {
    const file =
      typeof arg === 'string' ? arg : (arg as { readonly file?: string } | undefined)?.file
    const scope = scopeOf()
    if (nonEmpty(file) && scope !== undefined) return openPath(scope.repoRoot, file, scope.auth)
    return undefined
  })
  register('agentic.openFile', (path) => {
    const scope = scopeOf()
    if (nonEmpty(path) && scope !== undefined) return openPath(scope.repoRoot, path, scope.auth)
    return undefined
  })
  register('agentic.openDiff', (args) => {
    // `repoRoot` NUNCA vem do argumento: e sempre o projeto detectado nesta janela.
    const repoRoot = host.project?.repoRoot
    const input = args as Partial<Omit<OpenDiffArgs, 'repoRoot'>> | undefined
    if (
      repoRoot === undefined ||
      !nonEmpty(input?.path) ||
      !nonEmpty(input?.base) ||
      !nonEmpty(input?.head)
    ) {
      return undefined
    }
    return openDiff({ repoRoot, path: input.path, base: input.base, head: input.head })
  })
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider()),
  )
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
