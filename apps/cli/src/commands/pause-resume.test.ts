import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureDeps,
  createWorkspace,
  fakePlane,
  RUN_ID,
  recordingLink,
  seedPersistedRun,
  type Workspace,
} from '../__fixtures__/harness.js'
import type { CommandDeps } from '../deps.js'
import { NO_CONTROL_PLANE_HEADER } from '../plane.js'
import { type CommandResult, EXIT_OK } from '../result.js'
import {
  pauseCommand,
  resumeCommand,
  stopCommand,
  taskRetryCommand,
  taskSkipCommand,
  taskUnblockCommand,
} from './mutations.js'

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

type Mutation = (deps: CommandDeps) => Promise<CommandResult>

/** Os seis comandos que MUTAM estado. Todos passam pelo mesmo caminho — e pela mesma recusa. */
const MUTATIONS: readonly (readonly [string, Mutation])[] = [
  ['mission pause', (deps) => pauseCommand({ runId: RUN_ID }, deps)],
  ['mission resume', (deps) => resumeCommand({ runId: RUN_ID }, deps)],
  ['mission stop', (deps) => stopCommand({ runId: RUN_ID }, deps)],
  ['task retry', (deps) => taskRetryCommand({ taskId: 'T01', runId: RUN_ID }, deps)],
  [
    'task unblock',
    (deps) => taskUnblockCommand({ taskId: 'T01', runId: RUN_ID, note: 'ambiente ajustado' }, deps),
  ],
  [
    'task skip',
    (deps) => taskSkipCommand({ taskId: 'T01', runId: RUN_ID, reason: 'fora do escopo' }, deps),
  ],
]

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('mensagem quando nao ha control plane', () => {
  it('as tres primeiras linhas sao o comando exato, na ordem', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir, connect: () => Promise.resolve(undefined) })

    const error = (await pauseCommand({ runId: RUN_ID }, captured.deps).catch(
      (raised: unknown) => raised,
    )) as Error

    expect(error.message.split('\n').slice(0, 3)).toEqual([
      'Nenhum control plane ativo.',
      '  Suba:    agentic serve',
      '  Depois:  agentic mission pause <run>',
    ])
  })

  it('o cabecalho exportado e exatamente o que vai para o humano', () => {
    expect(NO_CONTROL_PLANE_HEADER).toBe(
      'Nenhum control plane ativo.\n  Suba:    agentic serve\n  Depois:  agentic mission pause <run>',
    )
  })

  for (const [name, mutation] of MUTATIONS) {
    it(`\`${name}\` recusa com o mesmo caminho de volta`, async () => {
      workspace = await createWorkspace()
      const captured = captureDeps({
        cwd: workspace.dir,
        connect: () => Promise.resolve(undefined),
      })

      const error = (await mutation(captured.deps).catch((raised: unknown) => raised)) as {
        readonly code: string
        readonly message: string
      }

      expect(error.code).toBe('NO_CONTROL_PLANE')
      expect(error.message.startsWith(NO_CONTROL_PLANE_HEADER)).toBe(true)
    })
  }
})

describe('nenhuma mutacao escreve no banco por fora do orquestrador (I7)', () => {
  it('a recusa nem chega a abrir o banco de estado', async () => {
    workspace = await createWorkspace()
    const dbPath = join(workspace.dir, '.agentic', 'state.db')
    expect(await exists(dbPath)).toBe(false)
    const captured = captureDeps({ cwd: workspace.dir, connect: () => Promise.resolve(undefined) })

    for (const [, mutation] of MUTATIONS) {
      await mutation(captured.deps).catch(() => undefined)
    }

    // Recusar e nao tocar no banco sao a mesma coisa aqui: sem processo, nao ha escritor.
    expect(await exists(dbPath)).toBe(false)
  })

  for (const [name, mutation] of MUTATIONS) {
    it(`\`${name}\` entrega por HTTP e NAO chama o caso de uso de escrita local`, async () => {
      workspace = await createWorkspace()
      const recorded = recordingLink()
      // `fakePlane` lanca em todo metodo nao declarado: se a CLI tentasse mutar o estado
      // pelo plane local (pauseRun, retryTask, ...), o teste quebrava aqui.
      const captured = captureDeps({
        cwd: workspace.dir,
        connect: () => Promise.resolve(recorded.link),
        controlPlane: () => fakePlane({}),
      })

      const result = await mutation(captured.deps)

      expect(result.exitCode).toBe(EXIT_OK)
      expect(recorded.requests).toHaveLength(1)
      expect(recorded.requests[0]?.method).toBe('POST')
      expect(recorded.requests[0]?.path.startsWith(`/api/runs/${RUN_ID}`)).toBe(true)
    })
  }

  it('o estado persistido continua identico depois das seis mutacoes entregues', async () => {
    workspace = await createWorkspace()
    await seedPersistedRun(workspace.dir, [{ taskId: 'T01', providerId: 'mock' }])
    const before = await readState(workspace.dir)
    const recorded = recordingLink()
    const captured = captureDeps({
      cwd: workspace.dir,
      connect: () => Promise.resolve(recorded.link),
    })

    for (const [, mutation] of MUTATIONS) {
      expect((await mutation(captured.deps)).exitCode).toBe(EXIT_OK)
    }

    // Comparacao nao vazia: ha run, ha task e ha evento no retrato de referencia.
    expect(before.runs).toHaveLength(1)
    expect(before.taskStatuses).toEqual(['RUNNING'])
    expect(before.events).toBeGreaterThan(0)
    // O control plane e que decide o que muda; a CLI so entregou seis pedidos.
    expect(await readState(workspace.dir)).toEqual(before)
    expect(recorded.requests).toHaveLength(MUTATIONS.length)
  })

  it('sem runId, a CLI LE o run corrente no banco e mesmo assim so entrega por HTTP', async () => {
    workspace = await createWorkspace()
    await seedPersistedRun(workspace.dir, [{ taskId: 'T01', providerId: 'mock' }])
    const before = await readState(workspace.dir)
    const recorded = recordingLink()
    const captured = captureDeps({
      cwd: workspace.dir,
      connect: () => Promise.resolve(recorded.link),
    })

    // Sem `runId` o comando abre o banco de verdade — para LER qual e o run corrente.
    const result = await pauseCommand({}, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(recorded.requests[0]?.path).toBe(`/api/runs/${RUN_ID}/pause`)
    expect(await readState(workspace.dir)).toEqual(before)
  })
})

interface StateSnapshot {
  readonly runs: readonly { readonly id: string; readonly status: string }[]
  readonly events: number
  readonly taskStatuses: readonly string[]
}

/** Retrato do banco por leitura direta: se alguem escrever por fora, isto muda. */
async function readState(dir: string): Promise<StateSnapshot> {
  const { openPersistence } = await import('@agentic/persistence')
  const persistence = openPersistence({ baseDir: join(dir, '.agentic') })
  try {
    const runs = persistence.queries.listRuns().map((row) => ({
      id: String(row.id),
      status: String((row as { readonly status?: unknown }).status),
    }))
    const taskRuns = await persistence.runs.loadTaskRuns(RUN_ID as never)
    const events = await persistence.events.list(RUN_ID as never)
    return {
      runs,
      events: events.length,
      taskStatuses: taskRuns.map((task) => task.status),
    }
  } finally {
    persistence.close()
  }
}
