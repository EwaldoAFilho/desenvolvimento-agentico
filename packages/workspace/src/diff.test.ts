import { pathScope } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import {
  buildObservation,
  excludeLinkedPaths,
  mergeDiffEntries,
  parseNameStatusZ,
  parseNumstatZ,
  scopedPaths,
} from './diff.js'
import { parseWorktreeList } from './repo.js'

const scope = (touches: string[], deny: string[] = []) => ({
  touches: touches.map(pathScope),
  denyPaths: deny.map(pathScope),
})

describe('parseNameStatusZ', () => {
  it('le status simples separados por NUL', () => {
    const entries = parseNameStatusZ('M\0a.txt\0A\0src/b.ts\0D\0old.ts\0')
    expect(entries).toEqual([
      { change: 'M', path: 'a.txt' },
      { change: 'A', path: 'src/b.ts' },
      { change: 'D', path: 'old.ts' },
    ])
  })

  it('le renomeio com origem e destino', () => {
    const entries = parseNameStatusZ('R100\0src/one.ts\0src/two.ts\0')
    expect(entries).toEqual([{ change: 'R', path: 'src/two.ts', renamedFrom: 'src/one.ts' }])
  })

  it('nao perde caminho com status desconhecido', () => {
    const entries = parseNameStatusZ('U\0conflito.ts\0')
    expect(entries).toEqual([{ change: 'M', path: 'conflito.ts' }])
  })

  it('aceita caminho com espaco e acento sem escape', () => {
    const entries = parseNameStatusZ('A\0doc/relatório final.md\0')
    expect(entries[0]?.path).toBe('doc/relatório final.md')
  })
})

describe('parseNumstatZ', () => {
  it('le contagens por arquivo', () => {
    expect(parseNumstatZ('3\t1\ta.txt\0')).toEqual([{ path: 'a.txt', added: 3, removed: 1 }])
  })

  it('le renomeio em tres tokens', () => {
    expect(parseNumstatZ('0\t0\t\0src/one.ts\0src/two.ts\0')).toEqual([
      { path: 'src/two.ts', added: 0, removed: 0, renamedFrom: 'src/one.ts' },
    ])
  })

  it('trata binario (-) como zero linhas', () => {
    expect(parseNumstatZ('-\t-\timg.png\0')).toEqual([{ path: 'img.png', added: 0, removed: 0 }])
  })
})

describe('mergeDiffEntries', () => {
  it('junta status com contagem', () => {
    const changes = mergeDiffEntries(
      parseNameStatusZ('M\0a.txt\0A\0b.ts\0'),
      parseNumstatZ('3\t1\ta.txt\0'),
    )
    expect(changes).toEqual([
      { path: 'a.txt', change: 'M', added: 3, removed: 1 },
      { path: 'b.ts', change: 'A', added: 0, removed: 0 },
    ])
  })

  it('mantem o caminho de origem do renomeio', () => {
    const changes = mergeDiffEntries(
      parseNameStatusZ('R100\0src/one.ts\0src/two.ts\0'),
      parseNumstatZ('0\t0\t\0src/one.ts\0src/two.ts\0'),
    )
    expect(changes[0]?.renamedFrom).toBe('src/one.ts')
    expect(scopedPaths(changes)).toEqual(['src/two.ts', 'src/one.ts'])
  })
})

describe('excludeLinkedPaths', () => {
  it('tira da observacao o que o workspaceSetup ligou', () => {
    const changes = mergeDiffEntries(
      parseNameStatusZ('A\0node_modules/x/index.js\0A\0src/a.ts\0'),
      parseNumstatZ(''),
    )
    expect(excludeLinkedPaths(changes, ['node_modules']).map((c) => c.path)).toEqual(['src/a.ts'])
  })
})

describe('buildObservation', () => {
  const changes = mergeDiffEntries(
    parseNameStatusZ('M\0packages/a/a.ts\0'),
    parseNumstatZ('2\t1\tpackages/a/a.ts\0'),
  )

  it('aprova o que esta dentro de touches', () => {
    const observation = buildObservation({ changes, scope: scope(['packages/a/']), patch: 'p' })
    expect(observation.scopeCheck).toBe('PASS')
    expect(observation.outOfScopePaths).toEqual([])
    expect(observation.diffStat).toEqual({ files: 1, added: 2, removed: 1 })
    expect(observation.patch).toBe('p')
  })

  it('reprova o que esta fora de touches', () => {
    const observation = buildObservation({ changes, scope: scope(['packages/b/']), patch: '' })
    expect(observation.scopeCheck).toBe('VIOLATION')
    expect(observation.outOfScopePaths).toEqual(['packages/a/a.ts'])
  })

  it('reprova denyPaths mesmo dentro de touches', () => {
    const denied = mergeDiffEntries(parseNameStatusZ('A\0.agentic/state.db\0'), parseNumstatZ(''))
    const observation = buildObservation({
      changes: denied,
      scope: scope(['.agentic/'], ['.agentic/']),
      patch: '',
    })
    expect(observation.scopeCheck).toBe('VIOLATION')
    expect(observation.outOfScopePaths).toEqual(['.agentic/state.db'])
  })

  it('fail-closed: caminho que nao se consegue classificar conta como fora de escopo', () => {
    const weird = mergeDiffEntries(parseNameStatusZ('A\0../fora.ts\0'), parseNumstatZ(''))
    const observation = buildObservation({
      changes: weird,
      scope: scope(['packages/a/']),
      patch: '',
    })
    expect(observation.scopeCheck).toBe('VIOLATION')
    expect(observation.outOfScopePaths).toEqual(['../fora.ts'])
  })

  it('verifica origem e destino do renomeio', () => {
    const moved = mergeDiffEntries(
      parseNameStatusZ('R100\0packages/b/b.ts\0packages/a/b.ts\0'),
      parseNumstatZ(''),
    )
    const observation = buildObservation({
      changes: moved,
      scope: scope(['packages/a/']),
      patch: '',
    })
    expect(observation.scopeCheck).toBe('VIOLATION')
    expect(observation.outOfScopePaths).toEqual(['packages/b/b.ts'])
  })
})

describe('parseWorktreeList', () => {
  it('le o porcelain do git worktree list', () => {
    const raw = [
      'worktree /repo',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /repo/.agentic/worktrees/R/T01-a1',
      'HEAD bbb',
      'branch refs/heads/task/M/T01/a1',
      '',
    ].join('\n')
    expect(parseWorktreeList(raw)).toEqual([
      { path: '/repo', head: 'aaa', branch: 'main', bare: false, detached: false },
      {
        path: '/repo/.agentic/worktrees/R/T01-a1',
        head: 'bbb',
        branch: 'task/M/T01/a1',
        bare: false,
        detached: false,
      },
    ])
  })

  it('marca worktree destacada', () => {
    const raw = ['worktree /repo/x', 'HEAD ccc', 'detached', ''].join('\n')
    expect(parseWorktreeList(raw)[0]?.detached).toBe(true)
  })
})
