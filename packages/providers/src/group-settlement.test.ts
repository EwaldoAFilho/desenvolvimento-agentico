import { rm } from 'node:fs/promises'
import nodeProcess from 'node:process'
import { createLocalAgentRuntime, type LocalAgentRuntimeDeps } from '@agentic/agent-runtime'
import { afterAll, describe, expect, it } from 'vitest'
import { dispatchContext, executeAssignment } from './__fixtures__/assignments.js'
import { makeTempDir } from './__fixtures__/fake-cli.js'
import type { LocalCliDescriptor } from './local-cli.js'
import { LocalCliAgentProvider } from './local-cli.js'
import { MockAgentProvider } from './mock.js'

/**
 * B1-final — o adapter nao pode DESCARTAR `groupTerminated`.
 *
 * O primitivo de processo sabe quando o lider saiu e o grupo NAO assentou. Se a reducao
 * `ExitStatus -> AgentOutcome` perder esse fato, o orquestrador observa uma worktree que um
 * descendente ainda muta e o encerramento devolve a posse com o efeito vivo (I15). O contrato
 * vale para toda forma de saida: natural, cancelada, por timeout.
 */

const workspaces: string[] = []

function worktree(): string {
  const path = makeTempDir('agentic-group-ws-')
  workspaces.push(path)
  return path
}

afterAll(async () => {
  for (const path of workspaces) await rm(path, { recursive: true, force: true })
})

/** O primitivo de processo, visto por este pacote so atraves do runtime de agente. */
type RuntimeDeps = NonNullable<LocalAgentRuntimeDeps['processDeps']>

const TETOS: RuntimeDeps = { killGraceMs: 200, groupGraceMs: 100, closeGraceMs: 300 }

/** Provider real sobre `node -e`: processo, sinal e exit code de verdade, sem CLI de agente. */
function provider(js: string, processDeps: RuntimeDeps): LocalCliAgentProvider {
  const descriptor: LocalCliDescriptor = {
    id: 'no',
    command: nodeProcess.execPath,
    capabilities: {
      roles: ['executor', 'reviewer'],
      streaming: true,
      cancellation: true,
      readinessProbe: 'unsupported',
      reportsUsage: false,
    },
    versionArgs: ['--version'],
    // O prompt do assignment vai como ultimo argumento; o script o ignora.
    runArgs: ['-e', js],
  }
  return new LocalCliAgentProvider(descriptor, {
    runtime: createLocalAgentRuntime({ platform: 'linux', processDeps }),
    probeOnStart: false,
  })
}

const grupoVivo: RuntimeDeps = { ...TETOS, probeGroup: () => true }

describe('AgentOutcome.groupTerminated — o adapter de CLI local preserva o assentamento do grupo', () => {
  it('saida natural + descendente vivo alem do teto: completed, mas groupTerminated=false', async () => {
    const ws = worktree()
    const handle = await provider('process.stdout.write("feito\\n")', grupoVivo).start(
      executeAssignment(ws),
      dispatchContext(ws),
    )
    const outcome = await handle.result()
    expect(outcome.status).toBe('completed')
    expect(outcome.groupTerminated).toBe(false)
  }, 20_000)

  it('saida natural + grupo terminado (sonda real): groupTerminated=true', async () => {
    const ws = worktree()
    const handle = await provider('process.stdout.write("feito\\n")', TETOS).start(
      executeAssignment(ws),
      dispatchContext(ws),
    )
    const outcome = await handle.result()
    expect(outcome).toMatchObject({ status: 'completed', groupTerminated: true })
  }, 20_000)

  it('cancel + grupo vivo: cancel() rejeita PROCESS_GROUP_ALIVE e o outcome diz cancelled com groupTerminated=false', async () => {
    const ws = worktree()
    const handle = await provider('setTimeout(() => {}, 30000)', grupoVivo).start(
      executeAssignment(ws),
      dispatchContext(ws),
    )
    const erro = await handle.cancel('operador pediu parada').then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect((erro as { readonly code?: unknown } | undefined)?.code).toBe('PROCESS_GROUP_ALIVE')
    const outcome = await handle.result()
    expect(outcome).toMatchObject({ status: 'cancelled', groupTerminated: false })
  }, 20_000)

  it('cancel + grupo morto: cancel() resolve e o outcome diz cancelled com groupTerminated=true', async () => {
    const ws = worktree()
    const handle = await provider('setTimeout(() => {}, 30000)', TETOS).start(
      executeAssignment(ws),
      dispatchContext(ws),
    )
    await handle.cancel('operador pediu parada')
    expect(await handle.result()).toMatchObject({ status: 'cancelled', groupTerminated: true })
  }, 20_000)

  it('timeout + grupo vivo: timeout com groupTerminated=false', async () => {
    const ws = worktree()
    const handle = await provider('setTimeout(() => {}, 30000)', grupoVivo).start(
      executeAssignment(ws),
      dispatchContext(ws, { timeoutMs: 150 }),
    )
    expect(await handle.result()).toMatchObject({ status: 'timeout', groupTerminated: false })
  }, 20_000)
})

describe('AgentOutcome.groupTerminated — agente in-process', () => {
  it('mock nao tem grupo de processos: groupTerminated=true por definicao', async () => {
    const ws = worktree()
    const handle = await new MockAgentProvider().start(executeAssignment(ws), dispatchContext(ws))
    expect((await handle.result()).groupTerminated).toBe(true)
  })
})
