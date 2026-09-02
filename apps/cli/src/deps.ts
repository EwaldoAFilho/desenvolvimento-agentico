import nodeProcess from 'node:process'
import type { ProviderRegistry } from '@agentic/domain'
import {
  type ControlPlane,
  type ControlPlaneConfig,
  createControlPlane,
} from '@agentic/orchestrator'
import { createProviderRegistryFromProject } from '@agentic/providers'
import type { ProjectFile } from '@agentic/schemas'
import { attachServer, type ServerConfig } from '@agentic/server'
import { git, isGitRepo } from '@agentic/workspace'
import { type ConnectExpectation, type ControlPlaneLink, connectHttp } from './link.js'
import type { ExitCode } from './result.js'

export interface GitProbe {
  readonly installed: boolean
  readonly version: string
  readonly repository: boolean
  readonly detail: string
}

/**
 * Tudo que a CLI toca no mundo externo entra por aqui. Handler nunca chama `process`,
 * `fetch` ou `console` direto: o teste injeta e observa (ARCHITECTURE 2).
 */
export interface CommandDeps {
  readonly cwd: string
  stdout(text: string): void
  stderr(text: string): void
  exit(code: ExitCode): void
  now(): Date
  readonly env: Readonly<Record<string, string | undefined>>
  readonly nodeVersion: string
  /** Composition root aprovado: a CLI nao monta pecas por conta propria. */
  controlPlane(config: ControlPlaneConfig): ControlPlane
  registry(project: ProjectFile): ProviderRegistry
  /**
   * `undefined` = nenhum control plane DESTE PROJETO no ar naquele endereco.
   *
   * `expected` e o que impede um comando de mutacao chegar ao control plane de outro
   * repositorio quando a descoberta esta velha ou a porta foi reaproveitada.
   */
  connect(endpoint: string, expected?: ConnectExpectation): Promise<ControlPlaneLink | undefined>
  probeGit(cwd: string): Promise<GitProbe>
  /** Espera o encerramento do processo em primeiro plano (`serve`, `mission start`). */
  waitForShutdown(): Promise<void>
  /** Intervalo da espera enquanto o run esta PAUSED. Existe para o teste nao dormir. */
  readonly pausePollMs?: number
  /** Sobe a API HTTP+SSE. Injetavel para o teste nao abrir porta de verdade. */
  bootServer?(config: ServerConfig): Promise<BootedServer>
  /**
   * Publica a API sobre o control plane que ESTE processo ja abriu (`mission start
   * --serve`). Nao pode ser `bootServer`: aquele cria um plane proprio, e dois escritores
   * no mesmo banco quebram I7.
   */
  servePlane?(input: ServePlaneInput): Promise<BootedServer>
}

export interface ServePlaneInput {
  readonly plane: ControlPlane
  readonly project: ProjectFile
  readonly projectText: string
  readonly gatesText: string
  readonly repoRoot: string
  readonly port?: number
  /** Identidade do dono: liga o registro de descoberta a posse que este processo detem. */
  readonly instanceId?: string
}

/** Recorte de `RunningServer` de @agentic/server que a CLI realmente usa. */
export interface BootedServer {
  readonly url: string
  close(): Promise<void>
}

async function defaultGitProbe(cwd: string): Promise<GitProbe> {
  try {
    const result = await git(['--version'], { cwd, allowFailure: true })
    if (result.exitCode !== 0) {
      return {
        installed: false,
        version: 'unknown',
        repository: false,
        detail: result.stderr.trim(),
      }
    }
    const repository = await isGitRepo(cwd)
    return {
      installed: true,
      version: result.stdout.trim(),
      repository,
      detail: repository ? 'repositorio git valido' : 'diretorio fora de um repositorio git',
    }
  } catch (error) {
    return {
      installed: false,
      version: 'unknown',
      repository: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Politica de sinais do processo da CLI (ADR-0014):
 *
 * - o primeiro SIGINT/SIGTERM resolve a espera em curso e inicia o encerramento gracioso;
 * - um sinal que chega DURANTE o encerramento (ninguem esperando) e ABSORVIDO e registrado —
 *   nunca cai no tratador padrao do Node, que mataria o processo no meio da drenagem e
 *   soltaria a posse pelo SO com efeito em voo (I15);
 * - se o encerramento falhar e o comando voltar a esperar, um sinal absorvido dispara a nova
 *   tentativa na hora.
 *
 * Os tratadores sao permanentes: nunca `once`. Derrubar sem drenar e `kill -9`, de proposito.
 */
const hub = { pending: 0, waiter: undefined as (() => void) | undefined }

function onSignal(): void {
  const waiter = hub.waiter
  if (waiter !== undefined) {
    hub.waiter = undefined
    waiter()
    return
  }
  hub.pending += 1
  nodeProcess.stderr.write(
    'encerramento em andamento: o sinal foi registrado e vai disparar uma nova tentativa se ' +
      `esta falhar. Para derrubar sem drenar: kill -9 ${nodeProcess.pid}\n`,
  )
}

function defaultShutdown(): Promise<void> {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    if (!nodeProcess.listeners(signal).includes(onSignal)) nodeProcess.on(signal, onSignal)
  }
  if (hub.pending > 0) {
    hub.pending -= 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    hub.waiter = resolve
  })
}

export function defaultDeps(): CommandDeps {
  return {
    cwd: nodeProcess.cwd(),
    stdout: (text) => {
      nodeProcess.stdout.write(text)
    },
    stderr: (text) => {
      nodeProcess.stderr.write(text)
    },
    exit: (code) => {
      nodeProcess.exitCode = code
    },
    now: () => new Date(),
    env: nodeProcess.env,
    nodeVersion: nodeProcess.versions.node,
    controlPlane: (config) => createControlPlane(config),
    registry: (project) => createProviderRegistryFromProject(project),
    connect: (endpoint, expected) => connectHttp(endpoint, expected),
    probeGit: (cwd) => defaultGitProbe(cwd),
    waitForShutdown: defaultShutdown,
    servePlane: (input) => attachServer(input),
  }
}
