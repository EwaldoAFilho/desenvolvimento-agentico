import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import { messageOf } from '../core/project.js'
import type { HomeState, HostToWebview, MissionDetail } from '../webview/protocol.js'
import { isWebviewToHost } from '../webview/protocol.js'
import { openDiff, openPath } from './git-content.js'
import type { AgenticHost } from './host.js'
import type { AgenticLog } from './log.js'

/**
 * Painel "Agentic" (Project Home) no editor. Um so por janela.
 *
 * A webview nao tem rede (CSP sem `connect-src`) nem acesso a arquivo: tudo passa por
 * `postMessage` e e o host que consulta o control plane e abre arquivos. Mensagem com tipo
 * desconhecido e descartada.
 */
export class HomePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined
  private selected: MissionDetail | undefined
  private selectedFile: string | undefined
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: AgenticHost,
    private readonly log: AgenticLog,
  ) {
    this.disposables.push(host.onDidChange(() => this.post()))
  }

  open(missionFile?: string): void {
    if (this.panel === undefined) {
      this.panel = vscode.window.createWebviewPanel(
        'agentic.home',
        'Agentic',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
            vscode.Uri.joinPath(this.context.extensionUri, 'media'),
          ],
        },
      )
      this.panel.iconPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'resources',
        'agentic.svg',
      )
      this.panel.webview.html = this.html(this.panel.webview)
      this.panel.webview.onDidReceiveMessage(
        (raw: unknown) => void this.receive(raw),
        undefined,
        this.disposables,
      )
      this.panel.onDidDispose(() => {
        this.panel = undefined
      })
    } else {
      this.panel.reveal()
    }
    if (missionFile !== undefined) void this.select(missionFile)
    else this.post()
  }

  private async receive(raw: unknown): Promise<void> {
    if (!isWebviewToHost(raw)) {
      this.log.warn(`webview: mensagem ignorada: ${JSON.stringify(raw).slice(0, 200)}`)
      return
    }
    const repoRoot = this.host.project?.repoRoot
    switch (raw.type) {
      case 'ready':
        this.post()
        return
      case 'refresh':
        await this.host.refresh({ data: true })
        if (this.selectedFile !== undefined) await this.select(this.selectedFile)
        return
      case 'start':
      case 'stop':
      case 'restart':
        await vscode.commands.executeCommand(`agentic.${raw.type}`)
        return
      case 'showLog':
        this.log.show()
        return
      case 'selectMission':
        await this.select(raw.file)
        return
      case 'openMissionFile':
        if (repoRoot !== undefined) await openPath(repoRoot, raw.file)
        return
      case 'openFile':
      case 'openWorktree':
        if (repoRoot !== undefined) await openPath(repoRoot, raw.path)
        return
      case 'openDiff':
        if (repoRoot !== undefined) {
          await openDiff({ repoRoot, path: raw.path, base: raw.base, head: raw.head }).catch(
            (error: unknown) =>
              vscode.window.showWarningMessage(`Agentic: diff indisponível: ${messageOf(error)}`),
          )
        }
        return
    }
  }

  async select(file: string): Promise<void> {
    this.selectedFile = file
    try {
      this.selected = await this.host.missionDetail(file)
    } catch (error) {
      this.selected = undefined
      this.log.warn(`detalhe da mission ${file}: ${messageOf(error)}`)
    }
    this.post()
  }

  private post(): void {
    if (this.panel === undefined) return
    const view = this.host.view()
    const state: HomeState = {
      service: view ?? { state: 'STOPPED', owned: false, since: new Date().toISOString() },
      missions: this.host.data.missions,
      updatedAt: new Date().toISOString(),
      ...(this.host.homeProject() === undefined ? {} : { project: this.host.homeProject() }),
      ...(this.host.data.providers === undefined ? {} : { providers: this.host.data.providers }),
      ...(this.host.data.runs === undefined ? {} : { runs: this.host.data.runs }),
      ...(this.selected === undefined ? {} : { selected: this.selected }),
      ...(this.host.busy === undefined ? {} : { busy: this.host.busy }),
      ...(this.host.data.error === undefined ? {} : { error: this.host.data.error }),
    }
    const message: HostToWebview = { type: 'state', state }
    void this.panel.webview.postMessage(message)
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64')
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'home.js'),
    )
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'home.css'),
    )
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
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
<div id="app" aria-live="polite">carregando…</div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`
  }

  dispose(): void {
    this.panel?.dispose()
    for (const d of this.disposables) d.dispose()
  }
}
