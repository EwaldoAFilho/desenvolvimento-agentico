import { describe, expect, it } from 'vitest'
import { isGitRef, isRepoPath, isWebviewToHost } from './protocol.js'

describe('protocolo da webview', () => {
  it('aceita apenas mensagens com tipo conhecido', () => {
    expect(isWebviewToHost({ type: 'start' })).toBe(true)
    expect(isWebviewToHost({ type: 'openFile', path: 'x' })).toBe(true)
    expect(isWebviewToHost({ type: 'openFile' })).toBe(false)
    expect(isWebviewToHost({ type: 'openFile', path: '' })).toBe(false)
    expect(isWebviewToHost({ type: 'openDiff', path: 'a', base: 'b' })).toBe(false)
    expect(isWebviewToHost({ type: 'openDiff', path: 'a', base: 'b', head: 'c' })).toBe(true)
    expect(isWebviewToHost({ type: 'selectMission', file: 1 })).toBe(false)
    expect(isWebviewToHost({ type: 'start', extra: 1 })).toBe(false)
    expect(isWebviewToHost({ type: 'openFile', path: 'x', extra: 1 })).toBe(false)
  })

  it('refs e caminhos do diff nunca viram opcao do git', () => {
    expect(isGitRef('task/DA-1/U01/a1')).toBe(true)
    expect(isGitRef('0123abcd')).toBe(true)
    expect(isGitRef('--output=/tmp/captura')).toBe(false)
    expect(isGitRef('-x')).toBe(false)
    expect(isGitRef('a b')).toBe(false)
    expect(isGitRef('a..b')).toBe(false)
    expect(isRepoPath('src/a.ts')).toBe(true)
    expect(isRepoPath('--output=x')).toBe(false)
    expect(isRepoPath('../fora')).toBe(false)
    expect(
      isWebviewToHost({ type: 'openDiff', path: 'x', base: '--output=/tmp/c', head: 'HEAD' }),
    ).toBe(false)
    expect(isWebviewToHost({ type: 'eval', code: '1' })).toBe(false)
    expect(isWebviewToHost('start')).toBe(false)
    expect(isWebviewToHost(null)).toBe(false)
  })
})
