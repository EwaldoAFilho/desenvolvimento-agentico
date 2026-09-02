import { describe, expect, it } from 'vitest'
import { isWebviewToHost } from './protocol.js'

describe('protocolo da webview', () => {
  it('aceita apenas mensagens com tipo conhecido', () => {
    expect(isWebviewToHost({ type: 'start' })).toBe(true)
    expect(isWebviewToHost({ type: 'openFile', path: 'x' })).toBe(true)
    expect(isWebviewToHost({ type: 'eval', code: '1' })).toBe(false)
    expect(isWebviewToHost('start')).toBe(false)
    expect(isWebviewToHost(null)).toBe(false)
  })
})
