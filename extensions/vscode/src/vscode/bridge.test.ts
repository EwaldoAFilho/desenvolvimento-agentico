import { describe, expect, it } from 'vitest'
import type { HostToWebviewBridge } from '../webview/bridge-protocol.js'
import { type BridgeCapabilities, type BridgeHttp, WebviewBridge } from './bridge.js'

function harness(http: BridgeHttp | undefined) {
  const posted: HostToWebviewBridge[] = []
  const opened: { path: string; published: string[] }[] = []
  const diffs: unknown[] = []
  const lifecycle: string[] = []
  const caps: BridgeCapabilities = {
    http: () => http,
    openPath: (path, published) => {
      opened.push({ path, published: [...published] })
      return Promise.resolve()
    },
    openDiff: (input) => {
      diffs.push(input)
      return Promise.resolve()
    },
    lifecycle: (op) => {
      lifecycle.push(op)
      return Promise.resolve()
    },
    showLog: () => undefined,
    navigated: () => undefined,
    log: () => undefined,
  }
  const bridge = new WebviewBridge(caps, (m) => posted.push(m))
  return { bridge, posted, opened, diffs, lifecycle }
}

const fakeHttp = (calls: unknown[]): BridgeHttp => ({
  baseUrl: 'http://127.0.0.1:1',
  repoRoot: '/repo',
  raw: (method, path, body, timeoutMs) => {
    calls.push({ method, path, body, timeoutMs })
    if (path === '/runs/1/tasks/T1') {
      return Promise.resolve({
        status: 200,
        ok: true,
        text: JSON.stringify({ isolation: { worktreePath: '/wt/T1' }, attempts: [] }),
      })
    }
    return Promise.resolve({ status: 200, ok: true, text: '[]' })
  },
})

describe('ponte do host', () => {
  it('api: repassa metodo, caminho relativo e corpo; planejamento ganha prazo longo', async () => {
    const calls: unknown[] = []
    const { bridge, posted } = harness(fakeHttp(calls))
    await bridge.receive({ type: 'api', id: 1, method: 'GET', path: '/runs' })
    await bridge.receive({
      type: 'api',
      id: 2,
      method: 'POST',
      path: '/missions/plan',
      body: '{"prompt":"x"}',
    })
    expect(calls).toEqual([
      { method: 'GET', path: '/runs', body: undefined, timeoutMs: 30_000 },
      { method: 'POST', path: '/missions/plan', body: '{"prompt":"x"}', timeoutMs: 900_000 },
    ])
    expect(posted[0]).toMatchObject({
      type: 'api.result',
      id: 1,
      status: 200,
      ok: true,
      text: '[]',
    })
  })

  it('control plane parado: 503 local, sem tentar a rede', async () => {
    const { bridge, posted } = harness(undefined)
    await bridge.receive({ type: 'api', id: 7, method: 'GET', path: '/runs' })
    expect(posted[0]).toMatchObject({ type: 'api.result', id: 7, status: 503, ok: false })
  })

  it('worktree vista numa resposta do control plane vira caminho autorizado para abrir', async () => {
    const { bridge, opened } = harness(fakeHttp([]))
    await bridge.receive({ type: 'editor.openPath', path: '/wt/T1' })
    expect(opened[0]?.published).toEqual([])
    await bridge.receive({ type: 'api', id: 1, method: 'GET', path: '/runs/1/tasks/T1' })
    await bridge.receive({ type: 'editor.openPath', path: '/wt/T1' })
    expect(opened[1]?.published).toEqual(['/wt/T1'])
  })

  it('mensagem malformada e descartada; diff so com refs validas', async () => {
    const { bridge, diffs, lifecycle } = harness(fakeHttp([]))
    await bridge.receive({ type: 'editor.openDiff', path: 'a', base: '--output=x', head: 'HEAD' })
    await bridge.receive({ type: 'eval', code: '1' })
    await bridge.receive({ type: 'lifecycle', op: 'start' })
    expect(diffs).toEqual([])
    expect(lifecycle).toEqual(['start'])
  })
})
