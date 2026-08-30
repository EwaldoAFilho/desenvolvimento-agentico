import { describe, expect, it } from 'vitest'
import { InvalidPathScopeError } from './errors.js'
import {
  findPathScopeConflicts,
  isPathInScope,
  outOfScopePaths,
  pathScope,
  pathScopeKind,
  pathScopeSetsConflict,
  pathScopesConflict,
} from './path-scope.js'

describe('PathScope', () => {
  it('normaliza separadores redundantes e "./"', () => {
    expect(pathScope('./packages//domain/')).toBe('packages/domain/')
    expect(pathScope('packages/domain/src/index.ts')).toBe('packages/domain/src/index.ts')
  })

  it.each(['../fora', 'packages/../../fora', '/absoluto', 'C:/win', '', '   ', 'a\\b'])(
    'rejeita %s',
    (raw) => {
      expect(() => pathScope(raw)).toThrow(InvalidPathScopeError)
    },
  )

  it.each(['src/*.ts', 'src/**', 'src/{a,b}', 'src/?.ts'])('rejeita glob %s', (raw) => {
    expect(() => pathScope(raw)).toThrow(InvalidPathScopeError)
  })

  it('distingue diretorio de arquivo pelo sufixo', () => {
    expect(pathScopeKind(pathScope('packages/domain/'))).toBe('directory')
    expect(pathScopeKind(pathScope('packages/domain/src/index.ts'))).toBe('file')
  })

  it('conflita quando um escopo e prefixo do outro', () => {
    expect(pathScopesConflict(pathScope('packages/'), pathScope('packages/domain/'))).toBe(true)
  })

  it('conflita quando os escopos sao iguais', () => {
    expect(pathScopesConflict(pathScope('packages/domain/'), pathScope('packages/domain/'))).toBe(
      true,
    )
  })

  it('nao conflita quando os escopos sao disjuntos', () => {
    expect(pathScopesConflict(pathScope('packages/domain/'), pathScope('packages/graph/'))).toBe(
      false,
    )
  })

  it('conflita arquivo dentro de diretorio', () => {
    expect(
      pathScopesConflict(pathScope('packages/domain/'), pathScope('packages/domain/src/a.ts')),
    ).toBe(true)
  })

  it('nao confunde prefixo textual com prefixo de caminho', () => {
    expect(pathScopesConflict(pathScope('src/a.ts'), pathScope('src/a.tsx'))).toBe(false)
    expect(pathScopesConflict(pathScope('packages/dom/'), pathScope('packages/domain/'))).toBe(
      false,
    )
  })

  it('lista os pares em conflito entre dois conjuntos', () => {
    const conflicts = findPathScopeConflicts(
      [pathScope('packages/domain/'), pathScope('docs/')],
      [pathScope('packages/domain/src/a.ts'), pathScope('apps/')],
    )
    expect(conflicts).toHaveLength(1)
    expect(pathScopeSetsConflict([pathScope('a/')], [pathScope('b/')])).toBe(false)
  })

  it('isPathInScope exige igualdade para arquivo e prefixo para diretorio', () => {
    expect(isPathInScope('packages/domain/src/a.ts', pathScope('packages/domain/'))).toBe(true)
    expect(isPathInScope('packages/domain/src/a.ts', pathScope('packages/domain/src/a.ts'))).toBe(
      true,
    )
    expect(isPathInScope('packages/domain/src/b.ts', pathScope('packages/domain/src/a.ts'))).toBe(
      false,
    )
  })

  it('outOfScopePaths acusa fora de touches e dentro de denyPaths', () => {
    const touches = [pathScope('packages/domain/')]
    const denied = [pathScope('.agentic/')]
    expect(
      outOfScopePaths(
        ['packages/domain/src/a.ts', 'packages/graph/src/b.ts', '.agentic/gates.yaml'],
        touches,
        denied,
      ),
    ).toEqual(['packages/graph/src/b.ts', '.agentic/gates.yaml'])
  })
})
