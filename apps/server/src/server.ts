import type { AdoptionResult, ControlPlane } from '@agentic/orchestrator'
import { createControlPlane } from '@agentic/orchestrator'
import { type ControlPlaneLease, canonicalIfPresent } from '@agentic/persistence'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { type BindAddress, loadProjectSources, resolveBind, type ServerConfig } from './config.js'
import {
  type ControlPlaneRuntime,
  controlPlaneFilePath,
  removeControlPlaneFile,
  writeControlPlaneFile,
} from './control-plane-file.js'
import { type ServerDeps, type ServerDepsInput, toServerDeps } from './deps.js'
import { registerErrorHandler } from './errors.js'
import { claimControlPlane, type ShutdownOptions, shutdownControlPlane } from './ownership.js'
import { PROJECT_HEADER, PROJECT_MISMATCH, runtimeDirOf } from './project-identity.js'
import { registerCommandRoutes } from './routes/commands.js'
import { registerMissionRoutes } from './routes/missions.js'
import { registerPlanningRoutes } from './routes/planning.js'
import { registerProjectRoutes } from './routes/project.js'
import { registerReadRoutes } from './routes/read.js'
import { closeStreams, registerStreamRoutes } from './routes/stream.js'
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
  registerProjectGuard(app, deps)
  registerReadRoutes(app, deps)
  registerStreamRoutes(app, deps)
  registerProjectRoutes(app, deps)
  registerMissionRoutes(app, deps)
  registerPlanningRoutes(app, deps)
  registerCommandRoutes(app, deps)
  registerStatic(app, deps)
  return app
}

/**
 * O servidor confere, na PROPRIA requisicao, que ela era para este projeto.
 *
 * O cliente sonda o `/api/health` antes de mandar o comando, e essa sonda ja recusa um
 * control plane de outro repositorio. O que ela nao cobre e a janela entre sondar e mandar:
 * o dono encerra, outro control plane — de OUTRO projeto — reaproveita a porta, e o comando
 * chega a um servidor legitimo que muta o run errado. Com a declaracao viajando junto, quem
 * decide e o servidor, sobre o projeto que ele POSSUI, e a janela deixa de existir.
 *
 * Ausencia do cabecalho passa, e isso NAO e o "undefined vira permissao" que 003B corrigiu
 * na posse: quem nao declara e o dashboard, servido por ESTE control plane, na mesma origem
 * — ele nao tem como estar falando com outro projeto. Quem PODE errar de endereco e a CLI, e
 * a CLI declara sempre.
 */
export function registerProjectGuard(app: FastifyInstance, deps: ServerDeps): void {
  const nosso = canonicalIfPresent(deps.repoRoot)
  app.addHook('onRequest', async (request, reply) => {
    const bruto = request.headers[PROJECT_HEADER]
    const declarado = Array.isArray(bruto) ? bruto[0] : bruto
    if (declarado === undefined || declarado.length === 0) return undefined
    if (canonicalIfPresent(declarado) === nosso) return undefined
    // Devolver a `reply` e o que ENCERRA o ciclo: sem isso o handler ainda rodaria, e a
    // recusa viraria uma mensagem depois do estrago.
    return reply.status(409).send({
      error: {
        code: PROJECT_MISMATCH,
        message:
          `este control plane possui ${deps.repoRoot}, e o comando foi endereçado a ` +
          `${declarado}: recusado para nao mutar o projeto errado (I14)`,
      },
    })
  })
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
  /**
   * Posse do projeto (I14). Presente so em `startServer`, que e quem disputa: `attachServer`
   * publica sobre um plane cuja posse ja foi resolvida por quem o abriu.
   */
  readonly lease?: ControlPlaneLease
  /**
   * Encerramento gracioso (I15): para de atender, cancela e drena os efeitos, fecha o banco
   * e so entao devolve a posse. Rejeita — SEM devolver a posse — se algum efeito nao parar
   * dentro do prazo. Idempotente.
   */
  close(options?: ShutdownOptions): Promise<void>
}

export interface AttachServerInput extends ServerDepsInput {
  readonly host?: string
  readonly port?: number
  readonly exposeExternally?: boolean
  readonly logger?: FastifyServerOptions['logger']
  /** `false` desliga a publicacao do registro de descoberta. */
  readonly publishRuntimeFile?: boolean
  /** Identidade do dono, para a descoberta apontar para a MESMA instancia que tem a posse. */
  readonly instanceId?: string
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
  // Derivado, nunca recebido: o registro de descoberta cai no MESMO diretorio que a posse
  // protege. Aceitar um caminho do chamador aqui separaria "onde o dono esta publicado" de
  // "o que o dono possui" — que e como a descoberta apontava para o vazio antes de 003B.
  const runtimeDir = runtimeDirOf(deps.repoRoot)

  // Publicar o registro e conveniencia de descoberta, nao o produto: se o disco recusar,
  // a API continua no ar e a CLI cai no endereco declarado em `project.yaml`.
  // Registro velho de um dono que morreu e sobrescrito aqui, sem cerimonia: quem chegou a
  // este ponto tem a posse, entao o endereco antigo so pode estar errado (FASE 10).
  let runtime: ControlPlaneRuntime | undefined
  if (input.publishRuntimeFile !== false) {
    runtime = await writeControlPlaneFile(runtimeDir, {
      host: address.host,
      port,
      repoRoot: deps.repoRoot,
      ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
    }).catch(() => undefined)
  }

  return {
    app,
    plane: input.plane,
    deps,
    address: bound,
    url: `http://${address.host}:${port}`,
    ...(runtime === undefined ? {} : { runtime, runtimeFile: controlPlaneFilePath(runtimeDir) }),
    close: async (): Promise<void> => {
      // Streams do dashboard primeiro: sao conexoes ativas que `app.close()` esperaria para
      // sempre. Depois a porta, ANTES de tirar o endereco do mapa: entre uma coisa e outra
      // ninguem pode receber um comando que este processo ja nao vai executar.
      closeStreams(app)
      await app.close()
      // So apaga o registro se ele ainda for o NOSSO. `instanceId` e a prova forte — pid e
      // porta sao reaproveitados, e um processo em encerramento nao pode apagar o registro
      // de uma instancia NOVA que subiu no lugar dele.
      if (runtime !== undefined) {
        await removeControlPlaneFile(
          runtimeDir,
          runtime.instanceId === undefined
            ? { pid: runtime.pid, port: runtime.port }
            : { instanceId: runtime.instanceId },
        )
      }
    },
  }
}

/**
 * Control plane no ar SEM run ativo — e o que torna possivel dar START MISSION pelo
 * dashboard (ARCHITECTURE 4). O bind e loopback por padrao; sair dele exige flag.
 *
 * A ordem do boot nao e estilo, e a garantia (I14). A posse do projeto e disputada ANTES de
 * `createControlPlane`, porque `createControlPlane` ja escreve: abre o banco em `readwrite`,
 * liga WAL e roda as migracoes. Quem perde a disputa sai por `ControlPlaneBusyError` sem ter
 * tocado em nada — sem banco, sem porta, sem descoberta, sem adocao.
 */
export async function startServer(config: ServerConfig = {}): Promise<RunningServer> {
  const sources = await loadProjectSources(config)
  // Recusa de bind acontece ANTES de abrir banco: nada e criado por um endereco proibido.
  resolveBind(config, sources.project)
  /**
   * UM diretorio de estado, daqui para baixo — e ele NAO e configuravel.
   *
   * Posse, `state.db` e `control-plane.json` moram no MESMO lugar, e esse lugar sai de
   * `projectIdentityOf` (I14). Antes, a posse ia para `<repoRoot>/.agentic` e o registro de
   * descoberta para onde o chamador quisesse: bastava `project.repoRoot` apontar para fora
   * para o banco de um entrypoint nao ser o do outro. E enquanto o chamador pudesse escolher
   * este caminho, duas chamadas de `startServer` sobre o mesmo `repoRoot` continuariam
   * podendo vencer duas posses.
   */
  const runtimeDir = sources.runtimeDir
  // Aqui, e so aqui, se decide quem manda neste projeto. `--port` nao participa.
  const lease = await claimControlPlane({
    runtimeDir,
    ...(config.instanceId === undefined ? {} : { instanceId: config.instanceId }),
  })
  /**
   * Do `claim` ate aqui, qualquer falha tem de devolver a posse.
   *
   * Um boot que quebra no meio — porta ocupada, banco corrompido, disco cheio — nao pode
   * deixar o projeto marcado como possuido por um processo que nao vai servir nada. E como
   * a posse morre com o processo, o caso perigoso e justamente o processo que SOBREVIVE a
   * falha: uma suite de testes, um supervisor que tenta de novo, a extensao do editor.
   *
   * A conexao do banco tambem: um plane aberto e abandonado segura o `state.db` sem ninguem
   * do outro lado.
   */
  let plane: ControlPlane
  try {
    plane = createControlPlane({
      project: sources.project,
      gatesFile: sources.gatesFile,
      repoRoot: sources.repoRoot,
      // O TEXTO dos dois arquivos ja esta em maos: compilar a proposta de plano e funcao pura
      // sobre conteudo, e passar daqui evita uma segunda leitura de disco que poderia divergir
      // do que este processo carregou.
      projectText: sources.projectText,
      gatesText: sources.gatesText,
      ...(config.missionsDir === undefined ? {} : { missionsDir: config.missionsDir }),
      // O banco mora onde a posse foi disputada, e ninguem escolhe isso: `createControlPlane`
      // deriva `<repoRoot>/.agentic` e recusa se o lease proteger outro diretorio.
      lease,
    })
  } catch (error) {
    lease.release()
    throw error
  }

  let running: RunningServer
  try {
    running = await attachServer({
      plane,
      instanceId: lease.instanceId,
      project: sources.project,
      projectText: sources.projectText,
      gatesText: sources.gatesText,
      repoRoot: sources.repoRoot,
      ...(config.missionsDir === undefined ? {} : { missionsDir: config.missionsDir }),
      ...(config.webDist === undefined ? {} : { webDist: config.webDist }),
      ...(config.heartbeatMs === undefined ? {} : { heartbeatMs: config.heartbeatMs }),
      ...(config.host === undefined ? {} : { host: config.host }),
      ...(config.port === undefined ? {} : { port: config.port }),
      ...(config.exposeExternally === undefined
        ? {}
        : { exposeExternally: config.exposeExternally }),
      ...(config.logger === undefined ? {} : { logger: config.logger }),
      ...(config.publishRuntimeFile === undefined
        ? {}
        : { publishRuntimeFile: config.publishRuntimeFile }),
    })
  } catch (error) {
    await plane.close().catch(() => undefined)
    lease.release()
    throw error
  }
  // A ordem do encerramento e garantia tanto quanto a do boot; ela vive em
  // `shutdownControlPlane`, com o porque de cada passo e um teste por regra.
  const close = (options: ShutdownOptions = {}): Promise<void> =>
    shutdownControlPlane(
      {
        stopAccepting: () => plane.quiesce(),
        stopServing: () => running.close(),
        stopEffects: (steps) => plane.close(steps),
        releaseOwnership: () => lease.release(),
      },
      options,
    )

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
    lease,
    close,
  }
}
