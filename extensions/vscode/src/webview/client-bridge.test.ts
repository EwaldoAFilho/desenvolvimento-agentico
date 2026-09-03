import { describe, expect, it } from 'vitest'
import type { WebviewToHostBridge } from './bridge-protocol.js'
import { createClientBridge } from './client-bridge.js'

describe('ponte do lado da webview', () => {
  it('request vira mensagem api e resolve com o resultado do host', async () => {
    const posted: WebviewToHostBridge[] = []
    const bridge = createClientBridge((m) => posted.push(m))
    const response = bridge.request('/runs', { method: 'POST', body: '{"x":1}' })
    expect(posted[0]).toEqual({
      type: 'api',
      id: 1,
      method: 'POST',
      path: '/runs',
      body: '{"x":1}',
    })
    expect(bridge.pending).toBe(1)
    bridge.dispatch({ type: 'api.result', id: 1, status: 201, ok: true, text: '{"runId":"r"}' })
    const result = await response
    expect(result.status).toBe(201)
    expect(await result.text()).toBe('{"runId":"r"}')
    expect(bridge.pending).toBe(0)
  })

  it('EventSource: abre com o caminho sem /api, entrega eventos por tipo, fecha uma vez', () => {
    const posted: WebviewToHostBridge[] = []
    const bridge = createClientBridge((m) => posted.push(m))
    const source = bridge.createEventSource('/api/runs/r/stream?since=3')
    expect(posted[0]).toEqual({ type: 'stream.open', streamId: 1, path: '/runs/r/stream?since=3' })
    const got: unknown[] = []
    source.addEventListener('event', (e) => got.push(e.data))
    const errors: unknown[] = []
    source.addEventListener('error', (e) => errors.push(e.data))
    bridge.dispatch({
      type: 'stream.event',
      streamId: 1,
      event: { type: 'event', data: '{"seq":4}', id: '4' },
    })
    bridge.dispatch({ type: 'stream.event', streamId: 1, event: { type: 'providers', data: '[]' } })
    bridge.dispatch({ type: 'stream.closed', streamId: 1, error: 'HTTP 500' })
    expect(got).toEqual(['{"seq":4}'])
    expect(errors).toEqual(['HTTP 500'])
    source.close()
    source.close()
    expect(posted.filter((m) => m.type === 'stream.close')).toHaveLength(1)
  })

  it('mensagens desconhecidas ou de ids alheios sao ignoradas; estado do host chega aos ouvintes', () => {
    const bridge = createClientBridge(() => undefined)
    const states: unknown[] = []
    const off = bridge.onHostState((s) => states.push(s.service.state))
    bridge.dispatch({ type: 'api.result', id: 99, status: 200, ok: true, text: '' })
    bridge.dispatch('lixo')
    bridge.dispatch({
      type: 'host',
      state: { service: { state: 'RUNNING', owned: true, spawning: false, since: '' } },
    })
    off()
    bridge.dispatch({
      type: 'host',
      state: { service: { state: 'STOPPED', owned: false, spawning: false, since: '' } },
    })
    expect(states).toEqual(['RUNNING'])
  })
})
