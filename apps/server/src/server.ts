import type { ControlPlane } from '@agentic/orchestrator'
import { createControlPlane } from '@agentic/orchestrator'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { type BindAddress, loadProjectSources, resolveBind, type ServerConfig } from './config.js'
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
  close(): Promise<void>
}

export interface AttachServerInput extends ServerDepsInput {
  readonly host?: string
  readonly port?: number
  readonly exposeExternally?: boolean
  readonly logger?: FastifyServerOptions['logger']
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
  return {
    app,
    plane: input.plane,
    deps,
    address,
    url: `http://${address.host}:${address.port}`,
    close: (): Promise<void> => app.close(),
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
  })
  return {
    ...running,
    close: async (): Promise<void> => {
      await running.close()
      await plane.close()
    },
  }
}
