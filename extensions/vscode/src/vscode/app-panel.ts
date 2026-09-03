import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import { messageOf } from '../core/project.js'
import type { AppRoute, HostState, HostToWebviewBridge } from '../webview/bridge-protocol.js'
import { WebviewBridge } from './bridge.js'
import { canonicalOrUndefined, openDiff, openPath, type PathAuthorization } from './git-content.js'
import type { AgenticHost } from './host.js'
import type { AgenticLog } from './log.js'

/**
 * A aba "Agentic" no editor: o dashboard do produto (React, `media/app.tsx`) atras da ponte.
 * Um painel por janela; a rota (Home / Mission / Run) vive no host para sobreviver ao
 * esconder/mostrar da aba e para a sidebar poder navegar.
 */
export class AppPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined
  private bridge: WebviewBridge | undefined
  private route: AppRoute = {}
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: AgenticHost,
    private readonly log: AgenticLog,
  ) {
    this.disposables.push(host.onDidChange(() => this.postState()))
  }

  /** Abre (ou revela) a aba e, se dada, muda a rota. */
  open(route?: AppRoute): void {
    if (route !== undefined) this.route = route
    if (this.panel === undefined) {
      this.panel = vscode.window.createWebviewPanel(
        'agentic.app',
        'Agentic',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
        },
      )
      this.panel.iconPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'resources',
        'agentic.svg',
      )
      this.bridge = new WebviewBridge(this.capabilities(), (message) => this.post(message))
      this.panel.webview.html = this.html(this.panel.webview)
      this.panel.webview.onDidReceiveMessage(
        (raw: unknown) => {
          void this.bridge?.receive(raw).then(() => {
            if (
              typeof raw === 'object' &&
              raw !== null &&
              (raw as { type?: unknown }).type === 'ready'
            ) {
              this.postState()
            }
          })
        },
        undefined,
        this.disposables,
      )
      this.panel.onDidDispose(() => {
        this.bridge?.dispose()
        this.bridge = undefined
        this.panel = undefined
      })
    } else {
      this.panel.reveal()
    }
    this.postState()
  }

  private capabilities() {
    const host = this.host
    const log = this.log
    return {
      http: () => {
        const client = host.client()
        return client === undefined ? undefined : client
      },
      openPath: async (path: string, published: ReadonlySet<string>) => {
        const project = host.project
        if (project === undefined) return
        const auth: PathAuthorization = { roots: [project.repoRoot, project.projectDir], published }
        await openPath(project.repoRoot, path, auth)
      },
      openDiff: async (input: {
        readonly path: string
        readonly base: string
        readonly head: string
      }) => {
        const repoRoot = host.project?.repoRoot
        if (repoRoot === undefined) return
        await openDiff({ repoRoot, ...input }).catch((error: unknown) =>
          vscode.window.showWarningMessage(`Agentic: diff indisponível: ${messageOf(error)}`),
        )
      },
      lifecycle: async (op: 'start' | 'stop' | 'restart') => {
        await host.lifecycle(op)
      },
      showLog: () => log.show(),
      navigated: (route: AppRoute) => {
        this.route = route
        this.updateTitle()
      },
      log: (line: string) => log.info(line),
      canonical: canonicalOrUndefined,
    }
  }

  private updateTitle(): void {
    if (this.panel === undefined) return
    const suffix =
      this.route.run !== undefined
        ? ` · run …${this.route.run.slice(-6)}`
        : this.route.mission !== undefined
          ? ` · ${this.route.mission}`
          : this.route.new === true
            ? ' · nova mission'
            : ''
    this.panel.title = `Agentic${suffix}`
  }

  private post(message: HostToWebviewBridge): void {
    void this.panel?.webview.postMessage(message)
  }

  private postState(): void {
    if (this.panel === undefined) return
    const view = this.host.view()
    const project = this.host.project
    const state: HostState = {
      service: view ?? {
        state: 'STOPPED',
        owned: false,
        spawning: false,
        since: new Date().toISOString(),
      },
      route: this.route,
      ...(project === undefined
        ? {}
        : {
            project: {
              name: project.name,
              repoRoot: project.repoRoot,
              ...(project.git.branch === undefined ? {} : { branch: project.git.branch }),
            },
          }),
      ...(this.host.defaultActor === undefined ? {} : { defaultActor: this.host.defaultActor }),
      ...(this.host.busy === undefined ? {} : { busy: this.host.busy }),
    }
    this.post({ type: 'host', state })
    this.updateTitle()
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64')
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'app.js'),
    )
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'app.css'),
    )
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      'img-src data:',
    ].join('; ')
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style.toString()}">
<title>Agentic</title>
</head>
<body>
<div id="root">carregando…</div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`
  }

  dispose(): void {
    this.bridge?.dispose()
    this.panel?.dispose()
    for (const d of this.disposables) d.dispose()
  }
}
