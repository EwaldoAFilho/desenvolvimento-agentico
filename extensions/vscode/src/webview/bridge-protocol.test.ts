import { describe, expect, it } from 'vitest'
import { isApiPath, isAppRoute, isWebviewToHostBridge } from './bridge-protocol.js'

describe('protocolo da ponte', () => {
  it('api: id, metodo, caminho relativo; corpo e prazo opcionais; sem chaves extras', () => {
    expect(isWebviewToHostBridge({ type: 'api', id: 1, method: 'GET', path: '/runs' })).toBe(true)
    expect(
      isWebviewToHostBridge({
        type: 'api',
        id: 1,
        method: 'POST',
        path: '/runs',
        body: '{}',
        timeoutMs: 1000,
      }),
    ).toBe(true)
    expect(isWebviewToHostBridge({ type: 'api', id: 1, method: 'DELETE', path: '/runs' })).toBe(
      false,
    )
    expect(isWebviewToHostBridge({ type: 'api', id: 1, method: 'GET', path: 'runs' })).toBe(false)
    expect(isWebviewToHostBridge({ type: 'api', id: 1, method: 'GET', path: '/../x' })).toBe(false)
    expect(isWebviewToHostBridge({ type: 'api', id: 1, method: 'GET', path: '//evil' })).toBe(false)
    expect(
      isWebviewToHostBridge({ type: 'api', id: 1, method: 'GET', path: '/runs', extra: 1 }),
    ).toBe(false)
    expect(isWebviewToHostBridge({ type: 'api', id: -1, method: 'GET', path: '/runs' })).toBe(false)
  })

  it('stream, editor, navegacao e lifecycle validados por inteiro', () => {
    expect(
      isWebviewToHostBridge({ type: 'stream.open', streamId: 3, path: '/runs/1/stream?since=0' }),
    ).toBe(true)
    expect(isWebviewToHostBridge({ type: 'stream.open', streamId: 3, path: 'http://x' })).toBe(
      false,
    )
    expect(isWebviewToHostBridge({ type: 'stream.close', streamId: 3 })).toBe(true)
    expect(isWebviewToHostBridge({ type: 'editor.openPath', path: 'src/a.ts' })).toBe(true)
    expect(isWebviewToHostBridge({ type: 'editor.openPath' })).toBe(false)
    expect(
      isWebviewToHostBridge({ type: 'editor.openDiff', path: 'a', base: 'abc', head: 'def' }),
    ).toBe(true)
    expect(
      isWebviewToHostBridge({
        type: 'editor.openDiff',
        path: 'a',
        base: '--output=x',
        head: 'def',
      }),
    ).toBe(false)
    expect(isWebviewToHostBridge({ type: 'navigated', route: { run: '01J' } })).toBe(true)
    expect(isWebviewToHostBridge({ type: 'navigated', route: { run: '01J', evil: 1 } })).toBe(false)
    expect(isWebviewToHostBridge({ type: 'lifecycle', op: 'start' })).toBe(true)
    expect(isWebviewToHostBridge({ type: 'lifecycle', op: 'kill' })).toBe(false)
    expect(isWebviewToHostBridge({ type: 'eval' })).toBe(false)
  })

  it('caminho de API e rota', () => {
    expect(isApiPath('/missions/plan')).toBe(true)
    expect(isApiPath('/a b')).toBe(false)
    expect(isAppRoute({})).toBe(true)
    expect(isAppRoute({ new: true })).toBe(true)
    expect(isAppRoute({ new: false })).toBe(false)
  })
})
