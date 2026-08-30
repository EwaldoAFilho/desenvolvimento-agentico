import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { displayGateCwd, resolveGateCwd, resolveGateWorkspace } from './cwd.js'
import { isGateError } from './errors.js'

const WORKSPACE = '/tmp/agentic/worktrees/T07-1'

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return isGateError(error) ? error.code : 'NAO_E_GATE_ERROR'
  }
  return 'NAO_LANCOU'
}

describe('resolveGateWorkspace', () => {
  it('normaliza um caminho absoluto', () => {
    expect(resolveGateWorkspace(`${WORKSPACE}/./`)).toBe(resolve(WORKSPACE))
  })

  it('recusa caminho relativo: gate nunca cai na arvore principal por acidente', () => {
    expect(codeOf(() => resolveGateWorkspace('worktrees/T07-1'))).toBe('GATE_CONFIG_INVALID')
  })

  it('recusa workspace vazio', () => {
    expect(codeOf(() => resolveGateWorkspace('   '))).toBe('GATE_CONFIG_INVALID')
  })
})

describe('resolveGateCwd', () => {
  it('sem cwd declarado usa a raiz do workspace', () => {
    expect(resolveGateCwd(WORKSPACE)).toBe(resolve(WORKSPACE))
  })

  it('cwd declarado e relativo ao workspace, nunca ao processo', () => {
    expect(resolveGateCwd(WORKSPACE, 'apps/web')).toBe(join(resolve(WORKSPACE), 'apps/web'))
  })

  it('aceita "." e caminho que sobe mas continua dentro', () => {
    expect(resolveGateCwd(WORKSPACE, '.')).toBe(resolve(WORKSPACE))
    expect(resolveGateCwd(WORKSPACE, 'apps/../packages/gates')).toBe(
      join(resolve(WORKSPACE), 'packages/gates'),
    )
  })

  it('recusa cwd que escapa por ..', () => {
    expect(codeOf(() => resolveGateCwd(WORKSPACE, '../..'))).toBe('GATE_CWD_ESCAPE')
    expect(codeOf(() => resolveGateCwd(WORKSPACE, 'apps/../../outra'))).toBe('GATE_CWD_ESCAPE')
  })

  it('recusa cwd absoluto, mesmo apontando para dentro', () => {
    expect(codeOf(() => resolveGateCwd(WORKSPACE, `${WORKSPACE}/apps`))).toBe('GATE_CWD_ESCAPE')
    expect(codeOf(() => resolveGateCwd(WORKSPACE, 'C:\\projeto'))).toBe('GATE_CWD_ESCAPE')
  })

  it('recusa cwd vazio', () => {
    expect(codeOf(() => resolveGateCwd(WORKSPACE, '  '))).toBe('GATE_CWD_ESCAPE')
  })

  it('nao confunde diretorio irmao com prefixo de nome', () => {
    expect(codeOf(() => resolveGateCwd('/tmp/ws', '../ws-vizinho'))).toBe('GATE_CWD_ESCAPE')
  })
})

describe('displayGateCwd', () => {
  it('cai na raiz do workspace quando o cwd declarado e invalido', () => {
    expect(displayGateCwd(WORKSPACE, '../..')).toBe(resolve(WORKSPACE))
    expect(displayGateCwd(WORKSPACE, 'apps')).toBe(join(resolve(WORKSPACE), 'apps'))
  })
})
