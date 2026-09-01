import type { AdoptionResult, ControlPlane } from '@agentic/orchestrator'
import { createControlPlane } from '@agentic/orchestrator'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { type BindAddress, loadProjectSources, resolveBind, type ServerConfig } from './config.js'
import {
  type ControlPlaneRuntime,
  controlPlaneFilePath,
  removeControlPlaneFile,
  runtimeDirOf,
  writeControlPlaneFile,
} from './control-plane-file.js'
import { type ServerDeps, type ServerDepsInput, toServerDeps } from './deps.js'
import { registerErrorHandler } from './errors.js'
import { registerCommandRoutes } from './routes/commands.js'
import { registerMissionRoutes } from './routes/missions.js'
import { registerReadRoutes } from './routes/read.js'
import { registerStreamRoutes } from './routes/stream.js'
import { registerStatic } from './static.js'

export interface CreateServerInput extends ServerDepsInput {
  readonly logger?: FastifyServerOptions['logger']
}

/**
 * Camada FINA. Cada rota traduz uma entrada HTTP em UM caso de uso de
 * `@agentic/orchestrator` e uma saida em DTO de `@agentic/schemas`. Nao ha regra de
 * negocio aqui: o servidor nao escreve estado, nao decide despacho e nao interpreta grafo.
 */
export function createServer(input: CreateServerInput): FastifyInstance {
  const deps = toServerDeps(input)
  const app = Fastify({ logger: input.logger ?? false })
  registerErrorHandler(app)
  registerReadRoutes(app, deps)
  registerStreamRoutes(app, deps)
  registerMissionRoutes(app, deps)
  registerCommandRoutes(app, deps)
  registerStatic(app, deps)
  return app
}

export interface RunningServer {
  readonly app: FastifyInstance
  readonly plane: ControlPlane
  readonly deps: ServerDeps
  readonly address: BindAddress
  readonly url: string
  /** Caminho do `control-plane.json` publicado, quando foi possivel grava-lo. */
  readonly runtimeFile?: string
  readonly runtime?: ControlPlaneRuntime
  /**
   * Quem ganhou dono no boot (I13). Presente so em `startServer`: `attachServer` publica
   * sobre um plane que ja tem dono e adotar ali criaria um segundo.
   */
  readonly adoption?: AdoptionResult
  close(): Promise<void>
}

export interface AttachServerInput extends ServerDepsInput {
  readonly host?: string
  readonly port?: number
  readonly exposeExternally?: boolean
  readonly logger?: FastifyServerOptions['logger']
  /** Onde gravar o `control-plane.json`. Default: `<repoRoot>/.agentic`. */
  readonly runtimeDir?: string
  /** `false` desliga a publicacao do registro de descoberta. */
  readonly publishRuntimeFile?: boolean
}

/** Porta REAL do socket: com `port: 0` o valor pedido nao serve para ninguem se conectar. */
function boundPortOf(app: FastifyInstance, fallback: number): number {
  const address = app.server.address()
  return address !== null && typeof address === 'object' ? address.port : fallback
}

/**
 * Publica HTTP+SSE sobre um control plane que JA existe.
 *
 * `startServer` cria o proprio plane; aqui ele vem de fora, porque o processo que ja
 * orquestra um run (`agentic mission start --serve`) precisa publicar a API SEM abrir um
 * segundo escritor no mesmo banco (I7). `close` fecha o servidor e NAO o plane: quem o
 * abriu continua dono dele.
 */
export async function attachServer(input: AttachServerInput): Promise<RunningServer> {
  const deps = toServerDeps(input)
  const address = resolveBind(
    {
      ...(input.host === undefined ? {} : { host: input.host }),
      ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.exposeExternally === undefined ? {} : { exposeExternally: input.exposeExternally }),
    },
    input.project,
  )
  const app = createServer({
    ...deps,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  })
  await app.listen({ host: address.host, port: address.port })
  const port = boundPortOf(app, address.port)
  const bound: BindAddress = { ...address, port }
  const runtimeDir = input.runtimeDir ?? runtimeDirOf(deps.repoRoot)

  // Publicar o registro e conveniencia de descoberta, nao o produto: se o disco recusar,
  // a API continua no ar e a CLI cai no endereco declarado em `project.yaml`.
  let runtime: ControlPlaneRuntime | undefined
  if (input.publishRuntimeFile !== false) {
    runtime = await writeControlPlaneFile(runtimeDir, { host: address.host, port }).catch(
      () => undefined,
    )
  }

  return {
    app,
    plane: input.plane,
    deps,
    address: bound,
    url: `http://${address.host}:${port}`,
    ...(runtime === undefined ? {} : { runtime, runtimeFile: controlPlaneFilePath(runtimeDir) }),
    close: async (): Promise<void> => {
      // So apaga o registro se ele ainda for o NOSSO: outro processo pode ter subido depois.
      if (runtime !== undefined) {
        await removeControlPlaneFile(runtimeDir, { pid: runtime.pid, port: runtime.port })
      }
      await app.close()
    },
  }
}

/**
 * Control plane no ar SEM run ativo — e o que torna possivel dar START MISSION pelo
 * dashboard (ARCHITECTURE 4). O bind e loopback por padrao; sair dele exige flag.
 */
export async function startServer(config: ServerConfig = {}): Promise<RunningServer> {
  const sources = await loadProjectSources(config)
  // Recusa de bind acontece ANTES de abrir banco: nada e criado por um endereco proibido.
  resolveBind(config, sources.project)
  const plane = createControlPlane({
    project: sources.project,
    gatesFile: sources.gatesFile,
    repoRoot: sources.repoRoot,
    ...(config.databasePath === undefined ? {} : { databasePath: config.databasePath }),
  })
  const running = await attachServer({
    plane,
    project: sources.project,
    projectText: sources.projectText,
    gatesText: sources.gatesText,
    repoRoot: sources.repoRoot,
    ...(config.missionsDir === undefined ? {} : { missionsDir: config.missionsDir }),
    ...(config.webDist === undefined ? {} : { webDist: config.webDist }),
    ...(config.heartbeatMs === undefined ? {} : { heartbeatMs: config.heartbeatMs }),
    ...(config.host === undefined ? {} : { host: config.host }),
    ...(config.port === undefined ? {} : { port: config.port }),
    ...(config.exposeExternally === undefined ? {} : { exposeExternally: config.exposeExternally }),
    ...(config.logger === undefined ? {} : { logger: config.logger }),
    ...(config.runtimeDir === undefined ? {} : { runtimeDir: config.runtimeDir }),
    ...(config.publishRuntimeFile === undefined
      ? {}
      : { publishRuntimeFile: config.publishRuntimeFile }),
  })
  const close = async (): Promise<void> => {
    await running.close()
    await plane.close()
  }

  // READY e depois disto, nao antes: um run recuperavel sem dono e um run que o banco diz
  // estar andando e que ninguem faz andar (I13). A adocao vem DEPOIS do `listen` de
  // proposito — assim o dashboard ja atende enquanto os runs sao reassumidos, e uma
  // reconciliacao demorada nao adia a porta. Falha aqui nao deixa meio servidor de pe.
  let adoption: AdoptionResult
  try {
    adoption = await plane.adoptRecoverableRuns()
  } catch (error) {
    await close()
    throw error
  }

  return {
    ...running,
    adoption,
    close,
  }
}
