import { describe, expect, it } from 'vitest'
import { isGitRef, isRepoPath } from './protocol.js'

describe('validadores de refs e caminhos do git', () => {
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
  })
})
