import { join } from 'node:path'
import type { ControlPlane } from '@agentic/orchestrator'
import { runtimeDirOf } from '@agentic/server'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureDeps,
  createWorkspace,
  fakePlane,
  RUN_ID,
  RUN_SNAPSHOT,
  type Workspace,
} from '../__fixtures__/harness.js'
import type { ServePlaneInput } from '../deps.js'
import { main } from '../program.js'
import { EXIT_OK } from '../result.js'
import { missionApproveCommand } from './mission-approve.js'
import { missionStartCommand } from './mission-start.js'

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

/** Orquestrador de mentira: o teste dirige o ciclo de vida sem agente nenhum. */
class FakeOrchestrator {
  status: string | undefined = 'RUNNING'
  drains = 0
  started = false
  stopped = false
  onDrain: ((self: FakeOrchestrator) => void) | undefined

  start(): void {
    this.started = true
  }

  stop(): void {
    this.stopped = true
  }

  drain(): Promise<void> {
    this.drains += 1
    this.onDrain?.(this)
    return Promise.resolve()
  }
}

async function approvedRun(dir: string, file: string): Promise<string> {
  const captured = captureDeps({ cwd: dir })
  const result = await missionApproveCommand({ file, actor: 'ewaldo' }, captured.deps)
  expect(result.exitCode).toBe(EXIT_OK)
  return (result.data as { readonly specHash: string }).specHash
}

function planeOf(
  specHash: string,
  orchestrator: FakeOrchestrator,
  finalStatus?: string,
): ControlPlane {
  return fakePlane({
    persistence: {
      queries: { listRuns: () => [{ id: RUN_ID, mission_id: 'TESTE-001' }] },
      runs: {
        loadRun: () =>
          Promise.resolve({
            id: RUN_ID,
            missionId: 'TESTE-001',
            status: 'APPROVED',
            specHash,
          }),
      },
    } as never,
    startRun: () =>
      Promise.resolve({ id: RUN_ID, missionId: 'TESTE-001', status: 'RUNNING' } as never),
    open: () => Promise.resolve(orchestrator as never),
    getRunSnapshot: () =>
      Promise.resolve(
        finalStatus === undefined
          ? RUN_SNAPSHOT
          : { ...RUN_SNAPSHOT, run: { ...RUN_SNAPSHOT.run, status: finalStatus as never } },
      ),
  })
}

interface Published {
  readonly inputs: ServePlaneInput[]
  readonly closed: () => number
}

function servePlaneSpy(url = 'http://127.0.0.1:4317'): {
  readonly published: Published
  readonly serve: (input: ServePlaneInput) => Promise<{ url: string; close(): Promise<void> }>
} {
  const inputs: ServePlaneInput[] = []
  let closes = 0
  return {
    published: { inputs, closed: () => closes },
    serve: (input) => {
      inputs.push(input)
      return Promise.resolve({
        url,
        close: (): Promise<void> => {
          closes += 1
          return Promise.resolve()
        },
      })
    },
  }
}

describe('mission start publica a API por padrao', () => {
  it('sem flag nenhuma, sobe a API sobre o MESMO plane e diz o endereco', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const orchestrator = new FakeOrchestrator()
    const plane = planeOf(specHash, orchestrator)
    const spy = servePlaneSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => plane,
      servePlane: spy.serve,
    })

    const result = await missionStartCommand(
      { file: workspace.missionPath, acceptWarnings: true },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    // MESMO plane: um segundo control plane seria um segundo escritor no banco (I7).
    expect(spy.published.inputs[0]?.plane).toBe(plane)
    expect(captured.stdout()).toContain('http://127.0.0.1:4317')
    expect(captured.stdout()).toContain('mission pause')
    expect((result.data as { readonly servedAt?: string }).servedAt).toBe('http://127.0.0.1:4317')
  })

  it('entrega o repoRoot: o registro cai no `.agentic` que a CLI consulta', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const spy = servePlaneSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => planeOf(specHash, new FakeOrchestrator()),
      servePlane: spy.serve,
    })

    await missionStartCommand({ file: workspace.missionPath, acceptWarnings: true }, captured.deps)

    // O diretorio do registro NAO e escolhido pela CLI: ele e derivado do `repoRoot` pela
    // mesma conta que a posse usa (I14). O que a CLI entrega — e o que este teste fixa — e o
    // repositorio; deixar o caminho do estado configuravel era o bypass fechado em 003B.
    expect(spy.published.inputs[0]?.repoRoot).toBe(workspace.dir)
    expect(runtimeDirOf(workspace.dir)).toBe(join(workspace.dir, '.agentic'))
  })

  it('encerra quando o run termina: nao fica esperando Ctrl+C', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const orchestrator = new FakeOrchestrator()
    orchestrator.onDrain = (self) => {
      self.status = 'COMPLETED'
    }
    const spy = servePlaneSpy()
    let subscribed = false
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => planeOf(specHash, orchestrator),
      servePlane: spy.serve,
      // O sinal e ASSINADO desde o inicio (Ctrl+C com agente em voo tem de encerrar pelo
      // caminho gracioso), mas nunca chega: o comando tem de terminar mesmo assim.
      waitForShutdown: () => {
        subscribed = true
        return new Promise<void>(() => undefined)
      },
    })

    const result = await missionStartCommand(
      { file: workspace.missionPath, acceptWarnings: true },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(orchestrator.drains).toBe(1)
    expect(subscribed).toBe(true)
    // A porta e desligada junto com o processo: nada de registro apontando para o vazio.
    expect(spy.published.closed()).toBe(1)
  })

  it('`--no-serve` nao publica e explica como comandar o run', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const spy = servePlaneSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => planeOf(specHash, new FakeOrchestrator()),
      servePlane: spy.serve,
    })

    const result = await missionStartCommand(
      { file: workspace.missionPath, acceptWarnings: true, serve: false },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(spy.published.inputs).toHaveLength(0)
    expect(captured.stdout()).toContain('SEM API HTTP')
    expect(captured.stdout()).toContain('--no-serve')
    expect(captured.stdout()).toContain('agentic serve')
  })

  it('quando a API nao sobe, nao manda tirar uma flag que ninguem passou', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => planeOf(specHash, new FakeOrchestrator()),
      servePlane: () => Promise.reject(new Error('EADDRINUSE')),
    })

    const result = await missionStartCommand(
      { file: workspace.missionPath, acceptWarnings: true },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(captured.stderr()).toContain('EADDRINUSE')
    expect(captured.stdout()).toContain('SEM API HTTP')
    // O usuario nao passou `--no-serve`: mandar rodar "sem --no-serve" seria conselho falso.
    expect(captured.stdout()).not.toContain('sem `--no-serve`')
    expect(captured.stdout()).toContain('`--port <n>`')
  })

  it('encerramento que nao devolve a posse NAO sai: espera outro sinal e tenta de novo (I15)', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const orchestrator = new FakeOrchestrator()
    orchestrator.onDrain = (self) => {
      self.status = 'COMPLETED'
    }
    let closes = 0
    let sinais = 0
    const plane = planeOf(specHash, orchestrator)
    const base = plane.close
    // O primeiro `close` encontra efeito vivo dentro do prazo e rejeita; o segundo termina.
    ;(plane as { close: ControlPlane['close'] }).close = (options) => {
      closes += 1
      return closes === 1
        ? Promise.reject(new Error('run X: encerramento excedeu 30000ms com efeito ainda em voo'))
        : base(options)
    }
    const spy = servePlaneSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => plane,
      servePlane: spy.serve,
      waitForShutdown: () => {
        sinais += 1
        return sinais === 1 ? new Promise<void>(() => undefined) : Promise.resolve()
      },
    })

    const result = await missionStartCommand(
      { file: workspace.missionPath, acceptWarnings: true },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(closes).toBe(2)
    expect(captured.stdout()).toContain('nao encerrou limpo')
    expect(captured.stdout()).toContain('continua com este processo')
  })

  it('`--serve` mantem o control plane no ar depois que o run termina', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const orchestrator = new FakeOrchestrator()
    const spy = servePlaneSpy()
    let waited = false
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => planeOf(specHash, orchestrator),
      servePlane: spy.serve,
      waitForShutdown: () => {
        waited = true
        return Promise.resolve()
      },
    })

    await missionStartCommand(
      { file: workspace.missionPath, acceptWarnings: true, serve: true },
      captured.deps,
    )

    expect(orchestrator.started).toBe(true)
    expect(orchestrator.stopped).toBe(true)
    expect(orchestrator.drains).toBe(0)
    expect(waited).toBe(true)
    expect(captured.stdout()).toContain('Ctrl+C')
  })
})

describe('run pausado nao derruba o control plane', () => {
  it('pausado, o processo segue no ar; retomado, volta a despachar', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const orchestrator = new FakeOrchestrator()
    orchestrator.onDrain = (self) => {
      if (self.drains === 1) {
        // `mission pause` chegou por HTTP: nada novo e despachado, mas o run nao acabou.
        self.status = 'PAUSED'
        setTimeout(() => {
          self.status = 'RUNNING'
        }, 10)
        return
      }
      self.status = 'COMPLETED'
    }
    const spy = servePlaneSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => planeOf(specHash, orchestrator),
      servePlane: spy.serve,
      pausePollMs: 5,
      waitForShutdown: () => new Promise<void>(() => undefined),
    })

    const result = await missionStartCommand(
      { file: workspace.missionPath, acceptWarnings: true },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    // Drenou de novo depois do resume: `resume` volta a despachar.
    expect(orchestrator.drains).toBe(2)
    expect(captured.stdout()).toContain('run PAUSED')
    expect(captured.stdout()).toContain(`agentic mission resume ${RUN_ID}`)
    expect(captured.stdout()).toContain('retomado')
    // A API so cai no fim: enquanto pausado, `resume` tinha com quem falar.
    expect(spy.published.closed()).toBe(1)
  })

  it('pausado, Ctrl+C encerra o processo', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const orchestrator = new FakeOrchestrator()
    orchestrator.onDrain = (self) => {
      self.status = 'PAUSED'
    }
    const spy = servePlaneSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => planeOf(specHash, orchestrator),
      servePlane: spy.serve,
      pausePollMs: 5,
      // O Ctrl+C chega DEPOIS de o run pausar: o aviso de pausa precisa ter saido antes.
      waitForShutdown: () => new Promise<void>((resolve) => setTimeout(resolve, 30)),
    })

    const result = await missionStartCommand(
      { file: workspace.missionPath, acceptWarnings: true },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(orchestrator.drains).toBe(1)
    expect(captured.stdout()).toContain('run PAUSED')
    expect(spy.published.closed()).toBe(1)
  })
})

describe('o default aparece na linha de comando', () => {
  it('`mission start <arquivo>` publica a API sem pedir flag', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const spy = servePlaneSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => planeOf(specHash, new FakeOrchestrator()),
      servePlane: spy.serve,
    })

    const code = await main(
      ['node', 'agentic', 'mission', 'start', workspace.missionPath, '--accept-warnings'],
      captured.deps,
    )

    expect(code).toBe(EXIT_OK)
    expect(spy.published.inputs).toHaveLength(1)
  })

  it('`--no-serve` na linha de comando desliga a publicacao', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const spy = servePlaneSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => planeOf(specHash, new FakeOrchestrator()),
      servePlane: spy.serve,
    })

    const code = await main(
      [
        'node',
        'agentic',
        'mission',
        'start',
        workspace.missionPath,
        '--accept-warnings',
        '--no-serve',
      ],
      captured.deps,
    )

    expect(code).toBe(EXIT_OK)
    expect(spy.published.inputs).toHaveLength(0)
    expect(captured.stdout()).toContain('SEM API HTTP')
  })

  it('`--serve` na linha de comando continua valendo', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const orchestrator = new FakeOrchestrator()
    const spy = servePlaneSpy()
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => planeOf(specHash, orchestrator),
      servePlane: spy.serve,
      // `--serve` fica no ar ate o sinal: o teste manda o sinal na hora.
      waitForShutdown: () => Promise.resolve(),
    })

    const code = await main(
      [
        'node',
        'agentic',
        'mission',
        'start',
        workspace.missionPath,
        '--accept-warnings',
        '--serve',
      ],
      captured.deps,
    )

    expect(code).toBe(EXIT_OK)
    expect(orchestrator.started).toBe(true)
    expect(orchestrator.drains).toBe(0)
  })

  it('o help declara o default e as duas saidas', async () => {
    const captured = captureDeps()
    await main(['node', 'agentic', 'mission', 'start', '--help'], captured.deps)

    const help = captured.stdout()
    expect(help).toContain('publica a API HTTP')
    expect(help).toContain('--no-serve')
    expect(help).toContain('--serve')
  })
})

describe('o processo que sai diz como voltar', () => {
  it('run nao terminado: aponta `agentic serve` e os comandos de mutacao', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const orchestrator = new FakeOrchestrator()
    orchestrator.onDrain = (self) => {
      // Deadlock humano: o run parou, mas nao acabou.
      self.status = 'BLOCKED'
    }
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => planeOf(specHash, orchestrator, 'BLOCKED'),
      servePlane: servePlaneSpy().serve,
    })

    await missionStartCommand({ file: workspace.missionPath, acceptWarnings: true }, captured.deps)

    expect(captured.stdout()).toContain('status final: BLOCKED')
    expect(captured.stdout()).toContain('agentic serve')
    expect(captured.stdout()).toContain('agentic task unblock')
  })

  it('run concluido: nao oferece caminho de volta que nao existe', async () => {
    workspace = await createWorkspace()
    const specHash = await approvedRun(workspace.dir, workspace.missionPath)
    const orchestrator = new FakeOrchestrator()
    orchestrator.onDrain = (self) => {
      self.status = 'COMPLETED'
    }
    const captured = captureDeps({
      cwd: workspace.dir,
      controlPlane: () => planeOf(specHash, orchestrator, 'COMPLETED'),
      servePlane: servePlaneSpy().serve,
    })

    await missionStartCommand({ file: workspace.missionPath, acceptWarnings: true }, captured.deps)

    expect(captured.stdout()).toContain('status final: COMPLETED')
    expect(captured.stdout()).not.toContain('agentic task unblock')
  })
})
