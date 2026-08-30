import type { TaskId } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import {
  cancelTask,
  type HumanRunCommand,
  type OrchestratorCommands,
  pauseRun,
  resumeRun,
  retryTask,
  skipTask,
  stopRun,
  unblockTask,
} from './commands.js'

interface Call {
  readonly name: string
  readonly payload: unknown
}

function recorder(): { readonly calls: Call[]; readonly orchestrator: OrchestratorCommands } {
  const calls: Call[] = []
  const record =
    (name: string) =>
    (payload: unknown): Promise<void> => {
      calls.push({ name, payload })
      return Promise.resolve()
    }
  return {
    calls,
    orchestrator: {
      pause: record('pause') as (command: HumanRunCommand) => Promise<void>,
      resume: record('resume') as (command: HumanRunCommand) => Promise<void>,
      cancel: record('cancel') as (command: HumanRunCommand) => Promise<void>,
      cancelTask: record('cancelTask') as OrchestratorCommands['cancelTask'],
      unblockTask: record('unblockTask') as OrchestratorCommands['unblockTask'],
      retryTask: record('retryTask') as OrchestratorCommands['retryTask'],
      skipTask: record('skipTask') as OrchestratorCommands['skipTask'],
      tick: (): Promise<void> => {
        calls.push({ name: 'tick', payload: undefined })
        return Promise.resolve()
      },
    },
  }
}

const T01 = 'T01' as TaskId

describe('comandos de run', () => {
  it('pausa e para o run pelo unico escritor', async () => {
    const { calls, orchestrator } = recorder()
    await pauseRun(orchestrator, { actor: 'ana' })
    await stopRun(orchestrator, { actor: 'ana', reason: 'prioridade' })
    expect(calls.map((call) => call.name)).toEqual(['pause', 'cancel'])
  })

  it('retomar pede um tick imediato', async () => {
    const { calls, orchestrator } = recorder()
    await resumeRun(orchestrator, { actor: 'ana' })
    expect(calls.map((call) => call.name)).toEqual(['resume', 'tick'])
  })
})

describe('comandos de task', () => {
  it('recusa unblock sem nota', async () => {
    const { orchestrator } = recorder()
    await expect(unblockTask(orchestrator, { taskId: 'T01', note: '' } as never)).rejects.toThrow(
      /unblock recusado/,
    )
  })

  it('aceita unblock com nota e autor padrao', async () => {
    const { calls, orchestrator } = recorder()
    await unblockTask(orchestrator, { taskId: 'T01', note: 'ambiente corrigido' })
    expect(calls[0]?.payload).toEqual({
      taskId: T01,
      actor: 'humano',
      note: 'ambiente corrigido',
    })
  })

  it('recusa skip sem motivo', async () => {
    const { orchestrator } = recorder()
    await expect(skipTask(orchestrator, { taskId: 'T01', reason: '' } as never)).rejects.toThrow(
      /skip recusado/,
    )
  })

  it('recusa task com id fora do formato', async () => {
    const { orchestrator } = recorder()
    await expect(
      skipTask(orchestrator, { taskId: 'tarefa-1', reason: 'qualquer' } as never),
    ).rejects.toThrow(/skip recusado/)
  })

  it('encaminha retry com o motivo declarado', async () => {
    const { calls, orchestrator } = recorder()
    await retryTask(orchestrator, { taskId: 'T01', actor: 'ana', reason: 'flaky' })
    expect(calls[0]).toEqual({
      name: 'retryTask',
      payload: { taskId: T01, actor: 'ana', reason: 'flaky' },
    })
  })

  it('encaminha cancelamento de task', async () => {
    const { calls, orchestrator } = recorder()
    await cancelTask(orchestrator, { taskId: 'T01', reason: 'fora de escopo' })
    expect(calls[0]?.name).toBe('cancelTask')
  })
})
