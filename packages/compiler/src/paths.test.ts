import { pathScope } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import { deniedBy, isTopLevelDirectory } from './paths.js'

const DENY = ['.agentic/', '.git/', '.env', '*.pem']

describe('deniedBy', () => {
  it('nega o que esta dentro de um diretorio negado', () => {
    expect(deniedBy(pathScope('.agentic/runs/'), DENY)).toBe('.agentic/')
    expect(deniedBy(pathScope('.git/hooks/pre-commit'), DENY)).toBe('.git/')
  })

  it('nega o arquivo exato, e so ele', () => {
    expect(deniedBy(pathScope('.env'), DENY)).toBe('.env')
    expect(deniedBy(pathScope('.envrc'), DENY)).toBeUndefined()
  })

  it('nega por glob sem atravessar diretorio', () => {
    expect(deniedBy(pathScope('certs/server.pem'), DENY)).toBe('*.pem')
    expect(deniedBy(pathScope('certs/server.pem.txt'), DENY)).toBeUndefined()
  })

  it('deixa passar escopo legitimo', () => {
    expect(deniedBy(pathScope('packages/compiler/'), DENY)).toBeUndefined()
    expect(deniedBy(pathScope('package.json'), DENY)).toBeUndefined()
  })

  it('sem denyPaths nada e negado', () => {
    expect(deniedBy(pathScope('.agentic/runs/'), [])).toBeUndefined()
  })
})

describe('isTopLevelDirectory', () => {
  it('reconhece diretorio de topo inteiro', () => {
    expect(isTopLevelDirectory(pathScope('scripts/'))).toBe(true)
    expect(isTopLevelDirectory(pathScope('src/'))).toBe(true)
  })

  it('nao confunde com subdiretorio nem com arquivo na raiz', () => {
    expect(isTopLevelDirectory(pathScope('packages/compiler/'))).toBe(false)
    expect(isTopLevelDirectory(pathScope('package.json'))).toBe(false)
  })
})
