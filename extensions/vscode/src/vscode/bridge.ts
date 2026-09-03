import { PROJECT_HEADER } from '../core/contracts.js'
import { messageOf } from '../core/project.js'
import { openSse, type SseSubscription } from '../core/sse.js'
import {
  type HostToWebviewBridge,
  isWebviewToHostBridge,
  type WebviewToHostBridge,
} from '../webview/bridge-protocol.js'

/**
 * O lado do HOST da ponte. Sem `vscode` aqui de proposito: e testavel com dubles. Quem
 * cola no editor (`AppPanel`) entrega as capacidades — cliente HTTP, acoes de editor,
 * lifecycle — e recebe as mensagens a repassar a webview.
 *
 * Duas regras que este arquivo cobra:
 * - a webview nunca escolhe o endereco: o caminho e relativo e o host o cola ao control
 *   plane do projeto detectado (com o header de guarda do repoRoot);
 * - abrir arquivo/diff so dentro do repositorio, do diretorio de configuracao ou de
 *   caminhos que o proprio control plane devolveu (worktrees vistas nas respostas).
 */
export interface BridgeHttp {
  raw(
    method: 'GET' | 'POST',
    apiPath: string,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<{ readonly status: number; readonly ok: boolean; readonly text: string }>
  readonly baseUrl: string
  readonly repoRoot: string
}

export interface BridgeCapabilities {
  /** `undefined` = control plane parado: toda chamada de API responde 503 local. */
  http(): BridgeHttp | undefined
  openPath(path: string, published: ReadonlySet<string>): Promise<void>
  openDiff(input: {
    readonly path: string
    readonly base: string
    readonly head: string
  }): Promise<void>
  lifecycle(op: 'start' | 'stop' | 'restart'): Promise<void>
  showLog(): void
  navigated(route: { readonly run?: string; readonly mission?: string; readonly new?: true }): void
  log(line: string): void
  fetchFn?: typeof fetch
  /** Caminho real de uma worktree publicada; `undefined` = nao existe (nao entra na allowlist). */
  canonical?(path: string): Promise<string | undefined>
}

/** Planejamento e uma chamada longa (ate 10 min no control plane); o resto e curto. */
export const DEFAULT_API_TIMEOUT_MS = 30_000
export const PLAN_API_TIMEOUT_MS = 15 * 60_000

export class WebviewBridge {
  private readonly streams = new Map<number, SseSubscription>()
  /** Caminhos que o control plane publicou nas respostas (worktrees): autorizados para abrir. */
  private readonly published = new Set<string>()

  constructor(
    private readonly caps: BridgeCapabilities,
    private readonly post: (message: HostToWebviewBridge) => void,
  ) {}

  async receive(raw: unknown): Promise<void> {
    if (!isWebviewToHostBridge(raw)) {
      this.caps.log(`ponte: mensagem ignorada: ${JSON.stringify(raw).slice(0, 200)}`)
      return
    }
    await this.handle(raw)
  }

  private async handle(message: WebviewToHostBridge): Promise<void> {
    switch (message.type) {
      case 'ready':
        return
      case 'api':
        await this.api(message)
        return
      case 'stream.open':
        this.openStream(message.streamId, message.path)
        return
      case 'stream.close':
        this.closeStream(message.streamId)
        return
      case 'editor.openPath':
        await this.caps.openPath(message.path, this.published)
        return
      case 'editor.openDiff':
        await this.caps.openDiff({ path: message.path, base: message.base, head: message.head })
        return
      case 'navigated':
        this.caps.navigated(message.route)
        return
      case 'lifecycle':
        await this.caps.lifecycle(message.op)
        return
      case 'showLog':
        this.caps.showLog()
        return
    }
  }

  private async api(message: Extract<WebviewToHostBridge, { type: 'api' }>): Promise<void> {
    const http = this.caps.http()
    if (http === undefined) {
      this.post({
        type: 'api.result',
        id: message.id,
        status: 503,
        ok: false,
        text: JSON.stringify({
          error: { code: 'CONTROL_PLANE_STOPPED', message: 'control plane parado' },
        }),
      })
      return
    }
    // O prazo e do HOST, por rota: so o planejamento (chamada longa) ganha 15 min.
    const timeoutMs =
      message.path === '/missions/plan' ? PLAN_API_TIMEOUT_MS : DEFAULT_API_TIMEOUT_MS
    try {
      const result = await http.raw(message.method, message.path, message.body, timeoutMs)
      if (result.ok) await this.observe(message.path, result.text)
      this.post({ type: 'api.result', id: message.id, ...result })
    } catch (error) {
      this.post({
        type: 'api.result',
        id: message.id,
        status: 0,
        ok: false,
        text: JSON.stringify({ error: { code: 'TRANSPORT', message: messageOf(error) } }),
      })
    }
  }

  /** Worktrees que o control plane informou em detalhes de task viram caminhos autorizados. */
  private async observe(path: string, text: string): Promise<void> {
    if (!/^\/runs\/[^/]+\/tasks\/[^/?]+$/.test(path)) return
    try {
      const detail = JSON.parse(text) as {
        isolation?: { worktreePath?: unknown }
        attempts?: { worktreePath?: unknown }[]
      }
      const candidates = [
        detail.isolation?.worktreePath,
        ...(detail.attempts ?? []).map((a) => a.worktreePath),
      ]
      for (const candidate of candidates) {
        if (typeof candidate !== 'string' || candidate.length === 0) continue
        // A allowlist guarda o caminho REAL: e contra ele que `authorizePath` compara.
        const real =
          this.caps.canonical === undefined ? candidate : await this.caps.canonical(candidate)
        if (real !== undefined) this.published.add(real)
      }
    } catch {
      // corpo fora do contrato: nada a publicar
    }
  }

  private openStream(streamId: number, path: string): void {
    this.closeStream(streamId)
    const http = this.caps.http()
    if (http === undefined) {
      this.post({ type: 'stream.closed', streamId, error: 'control plane parado' })
      return
    }
    const subscription = openSse(
      `${http.baseUrl}/api${path}`,
      { [PROJECT_HEADER]: http.repoRoot },
      {
        onEvent: (event) => this.post({ type: 'stream.event', streamId, event }),
        onClose: (error) => {
          this.streams.delete(streamId)
          this.post({ type: 'stream.closed', streamId, ...(error === undefined ? {} : { error }) })
        },
      },
      this.caps.fetchFn ?? fetch,
    )
    this.streams.set(streamId, subscription)
  }

  private closeStream(streamId: number): void {
    const current = this.streams.get(streamId)
    if (current === undefined) return
    this.streams.delete(streamId)
    current.close()
  }

  dispose(): void {
    for (const [, subscription] of this.streams) subscription.close()
    this.streams.clear()
  }
}
