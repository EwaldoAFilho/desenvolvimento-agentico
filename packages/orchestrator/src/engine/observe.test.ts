import type { Observation, RunId, TaskId, Workspace } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import { attemptDirectory, observeAttempt } from './observe.js'
import type { ArtifactWriter, AttemptWorkspaceProvider } from './types.js'

const RUN = '01J0000000000000000000000A' as RunId
const T01 = 'T01' as TaskId

const workspace: Workspace = {
  id: 'ws',
  kind: 'git-worktree',
  path: '/tmp/w/T01-a1',
  leasedBy: 'att' as Workspace['leasedBy'],
}

const artifacts: ArtifactWriter = {
  write: (input) =>
    Promise.resolve({
      id: 'artifact-1',
      runId: input.runId,
      kind: input.kind,
      path: `runs/${input.runId}/${input.relativePath}`,
      absolutePath: `/tmp/${input.relativePath}`,
      digest: 'deadbeef',
      bytes: 10,
      createdAt: new Date(0),
    }),
}

function observationOf(
  overrides: Partial<Observation & { patch: string }> = {},
): Observation & { patch: string } {
  return {
    filesChanged: [{ path: 'packages/t01/a.ts', change: 'M', added: 1, removed: 0 }],
    diffStat: { files: 1, added: 1, removed: 0 },
    outOfScopePaths: [],
    scopeCheck: 'PASS',
    patch: 'diff --git a b',
    ...overrides,
  }
}

function providerOf(
  observation: Observation & { patch: string },
  commit: { sha: string; changed: boolean } = { sha: 'abc123', changed: true },
): AttemptWorkspaceProvider {
  return {
    acquire: () => Promise.resolve(workspace),
    diff: () => Promise.resolve(observation),
    commit: () => Promise.resolve(commit),
    release: () => Promise.resolve(),
  }
}

const base = {
  artifacts,
  runId: RUN,
  taskId: T01,
  attemptNumber: 1,
  workspace,
  enforceTouches: true,
  commitMessage: 'T01 a1: teste',
}

describe('observacao da tentativa (P05)', () => {
  it('nomeia o diretorio de artefatos por task e tentativa', () => {
    expect(attemptDirectory(T01, 2)).toBe('attempts/T01-a2')
  })

  it('commita e devolve o sha medido quando tudo esta em ordem', async () => {
    const result = await observeAttempt({
      ...base,
      workspaces: providerOf(observationOf()),
      agentStatus: 'completed',
    })
    expect(result.failure).toBeUndefined()
    expect(result.observation?.commit).toBe('abc123')
    expect(result.observation?.diffRef).toBe(`runs/${RUN}/attempts/T01-a1/patch.diff`)
  })

  it('reprova por SCOPE_VIOLATION antes de qualquer commit', async () => {
    const result = await observeAttempt({
      ...base,
      workspaces: providerOf(
        observationOf({ scopeCheck: 'VIOLATION', outOfScopePaths: ['fora/x.ts'] }),
      ),
      agentStatus: 'completed',
    })
    expect(result.failure?.code).toBe('SCOPE_VIOLATION')
    expect(result.failure?.detail).toContain('fora/x.ts')
    expect(result.observation?.commit).toBeUndefined()
  })

  it('respeita enforceTouches desligado', async () => {
    const result = await observeAttempt({
      ...base,
      enforceTouches: false,
      workspaces: providerOf(
        observationOf({ scopeCheck: 'VIOLATION', outOfScopePaths: ['fora/x.ts'] }),
      ),
      agentStatus: 'completed',
    })
    expect(result.failure).toBeUndefined()
  })

  it('reprova por NO_CHANGES quando nada foi alterado', async () => {
    const result = await observeAttempt({
      ...base,
      workspaces: providerOf(
        observationOf({
          filesChanged: [],
          diffStat: { files: 0, added: 0, removed: 0 },
          patch: '',
        }),
      ),
      agentStatus: 'completed',
    })
    expect(result.failure?.code).toBe('NO_CHANGES')
  })

  it('reprova por NO_CHANGES quando o commit nao muda nada', async () => {
    const result = await observeAttempt({
      ...base,
      workspaces: providerOf(observationOf(), { sha: 'abc', changed: false }),
      agentStatus: 'completed',
    })
    expect(result.failure?.code).toBe('NO_CHANGES')
  })

  it('traduz o desfecho do agente sem ler o relato dele', async () => {
    const provider = providerOf(observationOf())
    const failed = await observeAttempt({ ...base, workspaces: provider, agentStatus: 'failed' })
    const timeout = await observeAttempt({ ...base, workspaces: provider, agentStatus: 'timeout' })
    const cancelled = await observeAttempt({
      ...base,
      workspaces: provider,
      agentStatus: 'cancelled',
    })
    expect(failed.failure?.code).toBe('AGENT_ERROR')
    expect(timeout.failure?.code).toBe('AGENT_TIMEOUT')
    expect(cancelled.failure?.code).toBe('INTERRUPTED')
    // Mesmo em falha, o que foi medido continua registrado.
    expect(failed.observation?.diffStat.files).toBe(1)
  })

  it('classifica falha do workspace sem lancar', async () => {
    const result = await observeAttempt({
      ...base,
      workspaces: {
        ...providerOf(observationOf()),
        diff: () => Promise.reject(new Error('worktree sumiu')),
      },
      agentStatus: 'completed',
    })
    expect(result.failure).toEqual({ code: 'WORKSPACE_ERROR', detail: 'worktree sumiu' })
    expect(result.observation).toBeUndefined()
  })
})
