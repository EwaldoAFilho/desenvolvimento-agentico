import { describe, expect, it } from 'vitest'
import { diffStatOf, evaluateScope, hasEvidenceOfKind, observe } from './evidence.js'
import { gateStatusFromResults } from './gate.js'
import { pathScope } from './path-scope.js'

const touches = [pathScope('packages/domain/')]

function command(exitCode: number | null, timedOut = false) {
  return { command: 'npm test', cwd: '/wt', exitCode, durationMs: 10, truncated: false, timedOut }
}

describe('observacao e gate', () => {
  it('scopeCheck PASS quando tudo esta dentro de touches', () => {
    const observation = observe(
      [{ path: 'packages/domain/src/a.ts', change: 'M', added: 3, removed: 1 }],
      touches,
    )
    expect(observation.scopeCheck).toBe('PASS')
    expect(observation.diffStat).toEqual({ files: 1, added: 3, removed: 1 })
  })

  it('scopeCheck VIOLATION lista os caminhos fora do escopo (P04)', () => {
    const evaluation = evaluateScope(['packages/domain/src/a.ts', 'apps/web/src/b.ts'], touches, [
      pathScope('.agentic/'),
    ])
    expect(evaluation).toEqual({
      scopeCheck: 'VIOLATION',
      outOfScopePaths: ['apps/web/src/b.ts'],
    })
  })

  it('alteracao em denyPaths e violacao mesmo dentro de touches', () => {
    const evaluation = evaluateScope(
      ['.agentic/gates.yaml'],
      [pathScope('.agentic/')],
      [pathScope('.agentic/')],
    )
    expect(evaluation.scopeCheck).toBe('VIOLATION')
  })

  it('diffStatOf soma linhas de todos os arquivos', () => {
    expect(
      diffStatOf([
        { path: 'a', change: 'A', added: 2, removed: 0 },
        { path: 'b', change: 'D', added: 0, removed: 5 },
      ]),
    ).toEqual({ files: 2, added: 2, removed: 5 })
  })

  it('hasEvidenceOfKind identifica o tipo de evidencia', () => {
    const refs = [{ kind: 'gate' as const, sourceId: 'g1', digest: 'sha' }]
    expect(hasEvidenceOfKind(refs, 'gate')).toBe(true)
    expect(hasEvidenceOfKind(refs, 'review')).toBe(false)
  })

  it('gate PASS somente quando todo comando obrigatorio passa', () => {
    const commands = [{ run: 'npm test' }, { run: 'npm run e2e', required: false }]
    expect(gateStatusFromResults(commands, [command(0), command(1)])).toBe('PASS')
    expect(gateStatusFromResults(commands, [command(1), command(0)])).toBe('FAIL')
    expect(gateStatusFromResults(commands, [command(null), command(0)])).toBe('ERROR')
    expect(gateStatusFromResults(commands, [command(null, true), command(0)])).toBe('TIMEOUT')
  })
})
