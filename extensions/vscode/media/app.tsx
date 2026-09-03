import '@xyflow/react/dist/style.css'
import '../../../apps/web/src/styles.css'
import './app.css'

import { type JSX, StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App, type Route } from '../../../apps/web/src/App.js'
import { setApiTransport } from '../../../apps/web/src/api.js'
import { EditorActionsContext } from '../../../apps/web/src/editor-actions.js'
import type { EventSourceLike } from '../../../apps/web/src/hooks/useRunStream.js'
import type { HostState, WebviewToHostBridge } from '../src/webview/bridge-protocol.js'
import { createClientBridge } from '../src/webview/client-bridge.js'

/**
 * O dashboard do produto DENTRO do editor. E o mesmo `App` de `apps/web` — mesmas telas,
 * mesmos schemas — com duas trocas: o transporte (postMessage ao host em vez de `fetch`) e
 * a navegacao (em memoria; a URL da webview nao e nossa). Sem rede, sem `innerHTML` de dado.
 */
declare function acquireVsCodeApi(): { postMessage(message: WebviewToHostBridge): void }
const vscode = acquireVsCodeApi()

const bridge = createClientBridge((message) => vscode.postMessage(message))
setApiTransport({ request: (path, init) => bridge.request(path, init ?? {}) })
const createEventSource = (url: string): EventSourceLike => bridge.createEventSource(url)
window.addEventListener('message', (event: MessageEvent<unknown>) => bridge.dispatch(event.data))

function send(message: WebviewToHostBridge): void {
  vscode.postMessage(message)
}

function useHostState(): HostState | undefined {
  const [state, setState] = useState<HostState | undefined>(undefined)
  useEffect(() => bridge.onHostState(setState), [])
  return state
}

const editorActions = {
  openPath: (path: string): void => send({ type: 'editor.openPath', path }),
  openDiff: (input: {
    readonly path: string
    readonly base: string
    readonly head: string
  }): void => send({ type: 'editor.openDiff', ...input }),
}

function labelOf(state: HostState['service']['state']): string {
  switch (state) {
    case 'STARTING':
      return 'iniciando o control plane…'
    case 'STOPPING':
      return 'encerrando o control plane…'
    case 'FAILED':
      return 'o control plane não encerrou; Stop de novo tenta outra vez'
    default:
      return 'o control plane está parado'
  }
}

/** Portao: sem control plane no ar nao ha dashboard — ha o botao que o sobe. */
function Gate({ host }: { readonly host: HostState }): JSX.Element {
  const busy =
    host.busy !== undefined ||
    host.service.state === 'STARTING' ||
    host.service.state === 'STOPPING'
  return (
    <main className="gate" aria-live="polite">
      <h1>{host.project?.name ?? 'Agentic'}</h1>
      <p className="gate__status">{host.busy ?? labelOf(host.service.state)}</p>
      {host.service.failure === undefined ? null : (
        <pre className="gate__failure">{host.service.failure.message}</pre>
      )}
      <div className="gate__actions">
        {host.service.state === 'FAILED' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => send({ type: 'lifecycle', op: 'stop' })}
          >
            Stop de novo
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => send({ type: 'lifecycle', op: 'start' })}
          >
            Start Agentic
          </button>
        )}
        <button type="button" onClick={() => send({ type: 'showLog' })}>
          Ver log
        </button>
      </div>
    </main>
  )
}

function Shell(): JSX.Element {
  const host = useHostState()
  const route = host?.route
  const runStream = useMemo(() => ({ createEventSource }), [])
  const initialRoute = useMemo<Route>(() => route ?? {}, [route])
  if (host === undefined) return <main className="loading">conectando ao editor…</main>
  if (host.service.state !== 'RUNNING') return <Gate host={host} />
  return (
    <EditorActionsContext.Provider value={editorActions}>
      <App
        navigation="memory"
        initialRoute={initialRoute}
        onNavigate={(next) => send({ type: 'navigated', route: next })}
        runStream={runStream}
        {...(host.defaultActor === undefined ? {} : { defaultActor: host.defaultActor })}
      />
    </EditorActionsContext.Provider>
  )
}

const root = document.getElementById('root')
if (root === null) throw new Error('elemento #root ausente')
createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
)
send({ type: 'ready' })
