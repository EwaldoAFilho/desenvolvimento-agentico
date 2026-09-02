import { resolve } from 'node:path'
import nodeProcess from 'node:process'
import type { CompiledGraph } from '@agentic/compiler'
import {
  type AgentProfile,
  type AgentRole,
  type Clock,
  type IdGenerator,
  type Integrator,
  isRecoverableActiveRunStatus,
  isRunId,
  isRunStatus,
  type MissionSpec,
  type ProviderRegistry,
  RECOVERABLE_ACTIVE_RUN_STATUSES,
  type Run,
  type RunId,
  type RunStatus,
  type TaskId,
  agentProfileId as toAgentProfileId,
  providerId as toProviderId,
} from '@agentic/domain'
import { type GateProfiles, GateRunner, loadGateProfiles } from '@agentic/gates'
import {
  canonicalIfPresent,
  type DatabaseMode,
  openPersistence,
  type Persistence,
  runtimeDirOf,
} from '@agentic/persistence'
import {
  createProviderRegistryFromProject,
  type MockScript,
  type ProviderFactory,
} from '@agentic/providers'
import type { GatesFile, ProjectFile, RunSnapshot, TaskDetail } from '@agentic/schemas'
import {
  GitIntegrator,
  GitWorktreeWorkspaceProvider,
  SharedWorkspaceProvider,
} from '@agentic/workspace'
import {
  type ApplicationDeps,
  type ApproveMissionInput,
  approveMission,
  type CompileInput,
  type CompileResult,
  type CreateRunInput,
  compileMission,
  createRun,
  generateMissionReport,
  getRunSnapshot,
  getTaskDetail,
  loadMissionSpec,
  loadRun,
  type MissionReport,
  pauseRun,
  resumeRun,
  retryTask,
  type StartRunInput,
  skipTask,
  startRun,
  stopRun,
  unblockTask,
  validateMission,
} from '../application/index.js'
import { systemClock } from '../runtime/clock.js'
import { ulidGenerator } from '../runtime/ids.js'
import type { AgentLogConfig } from './agent-log.js'
import { CommandRefusedError } from './errors.js'
import { SharedTreeIntegrator } from './integration.js'
import {
  type HumanCommand,
  Orchestrator,
  type TaskCommandInput,
  type UnblockInput,
} from './orchestrator.js'
import type {
  AttemptWorkspaceProvider,
  EngineDeps,
  GateExecutor,
  MissionWorkspaceProvider,
} from './types.js'

/** Allowlist minima para o processo do agente. Nenhuma credencial e injetada (P17). */
export const DEFAULT_AGENT_ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR'] as const

/** Um run que passou a ter dono nesta instancia (ou que ja tinha). */
export interface RunAdoption {
  readonly runId: RunId
  readonly status: RunStatus
  /** `true` = a instancia ja era dona; a chamada nao criou orquestrador nenhum (I13). */
  readonly alreadyOwned: boolean
}

/** Run recuperavel que NAO ganhou dono, com o motivo — silencio aqui seria pior que a falha. */
export interface RunAdoptionRefusal {
  readonly runId: RunId
  readonly status: RunStatus
  readonly reason: string
}

export interface AdoptionResult {
  readonly adopted: readonly RunAdoption[]
  readonly refused: readonly RunAdoptionRefusal[]
}

/**
 * O que o control plane precisa saber da posse do projeto (I14): quem somos, O QUE possuimos
 * e se ainda possuimos. Nada de adquirir ou soltar — isso e do processo que fez o boot.
 * `ControlPlaneLease` de `@agentic/persistence` satisfaz esta forma.
 *
 * `ownedDir` nao e informativo: e o que amarra a posse ao projeto. Sem ele, um lease legitimo
 * de `/repo-A` autorizava um plane aberto sobre `/repo-B` — "ter algum lease" nao prova posse
 * DESTE projeto, e o control plane de B disputaria a propria posse sem saber que ja havia
 * outro escritor.
 */
export interface OwnershipLease {
  readonly instanceId: string
  /** Diretorio de estado que este lease protege — o `.agentic` canonico do projeto. */
  readonly ownedDir: string
  readonly held: boolean
  /**
   * Como ESTE lease revoga um escritor que ele autorizou. Obrigatorio de proposito.
   *
   * Um lease sem revogacao nao pode autorizar escrita: seria prometer que a capacidade morre
   * com a posse sem ter como cumprir, e foi assim que a funcao capturada antes do `release`
   * continuou escrevendo. Exigi-lo no TIPO faz o compilador cobrar de todo produtor de lease
   * — inclusive de um dublê de teste — em vez de deixar a garantia depender de lembrar.
   */
  onRelease(hook: () => void): () => void
}

export interface ControlPlaneConfig {
  readonly project: ProjectFile
  readonly gatesFile: GatesFile
  /**
   * Raiz do repositorio alvo. Default: `project.project.repoRoot`.
   *
   * E a UNICA entrada de identidade desta composicao. NAO existe `baseDir` nem
   * `databasePath`: `<repoRoot>/.agentic` e derivado por `runtimeDirOf`, a mesma conta de
   * `projectIdentityOf`. Enquanto o chamador podia escolher o diretorio de estado, ele podia
   * escolher um SEGUNDO estado para o mesmo projeto — e nenhum lock protege um caminho que
   * ninguem previu (I14).
   */
  readonly repoRoot?: string
  readonly clock?: Clock
  readonly ids?: IdGenerator
  readonly registry?: ProviderRegistry
  /** Roteiros dos providers in-process, por id — o caminho de teste sem LLM. */
  readonly scripts?: Readonly<Record<string, MockScript>>
  /** Substitui a construcao de um provider — usado pela suite para roteiros por tentativa. */
  readonly providerFactories?: Readonly<Record<string, ProviderFactory>>
  readonly gateRunner?: GateExecutor
  readonly agentEnvAllow?: readonly string[]
  /** Teto, redacao e espera do log do agente gravado por tentativa (ARCHITECTURE 6.1). */
  readonly agentLog?: AgentLogConfig
  readonly safetyIntervalMs?: number
  /**
   * Posse do projeto (I14). E ela que escolhe o MODO DA CONEXAO, e o modo e a fronteira.
   *
   * Com lease vivo deste projeto: conexao `readwrite`, e o plane e o dono. Sem lease, ou com
   * um lease ja solto: conexao `readonly`, aberta pelo SQLite em modo que o proprio driver
   * recusa escrever. Nao ha terceira possibilidade — `createControlPlane` nunca produz um
   * plane mutavel sem posse.
   *
   * A diferenca em relacao a 003B nao e de rigor, e de LUGAR. Antes a recusa vinha de um
   * espelho de JavaScript, e quem tivesse a referencia por baixo dele escrevia. Agora nao ha
   * nada por baixo: a conexao nao sabe escrever.
   */
  readonly lease?: OwnershipLease
}

export interface ControlPlane {
  readonly persistence: Persistence
  /**
   * O que este plane e: `owned` escreve, `readonly` so le. Nao ha semantica implicita —
   * quem recebe um plane pronto pode PERGUNTAR em vez de deduzir da presenca de um lease.
   */
  readonly access: ControlPlaneAccess
  /** Identidade do dono, quando este plane tem posse. Liga a posse a descoberta. */
  readonly instanceId?: string
  readonly registry: ProviderRegistry
  readonly gates: GateProfiles
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly deps: ApplicationDeps
  validateMission(input: CompileInput): ReturnType<typeof validateMission>
  compileMission(input: CompileInput): CompileResult
  createRun(input: Omit<CreateRunInput, 'project'> & { project?: ProjectFile }): Promise<Run>
  approveMission(input: ApproveMissionInput): Promise<Run>
  startRun(input: StartRunInput): Promise<Run>
  pauseRun(runId: RunId, command: HumanCommand): Promise<void>
  resumeRun(runId: RunId, command: HumanCommand): Promise<void>
  stopRun(runId: RunId, command: HumanCommand): Promise<void>
  unblockTask(runId: RunId, command: UnblockInput): Promise<void>
  retryTask(runId: RunId, command: TaskCommandInput): Promise<void>
  skipTask(runId: RunId, command: TaskCommandInput & { readonly reason: string }): Promise<void>
  cancelTask(runId: RunId, command: TaskCommandInput): Promise<void>
  getRunSnapshot(runId: RunId): Promise<RunSnapshot>
  getTaskDetail(runId: RunId, taskId: TaskId): Promise<TaskDetail>
  generateMissionReport(runId: RunId): Promise<MissionReport>
  open(runId: RunId): Promise<Orchestrator>
  adoptRecoverableRuns(): Promise<AdoptionResult>
  close(): Promise<void>
}

/**
 * O que este plane e — declarado, nunca deduzido.
 *
 * A Fase 15 da missao pede isto por escrito: `createControlPlane` constroi um plane
 * `owned` (posse provada, conexao mutavel) ou um plane `readonly` (consulta, conexao que o
 * SQLite recusa escrever). O terceiro caso — mutavel sem posse — nao existe como valor,
 * porque nao existe como estado alcancavel.
 */
export type ControlPlaneAccess = 'owned' | 'readonly'

/** Perfis declarados no projeto; sem declaracao, um por papel suportado pelo provider. */
export function profilesOf(project: ProjectFile): AgentProfile[] {
  const profiles: AgentProfile[] = []
  for (const [id, config] of Object.entries(project.providers.registry)) {
    const providerId = toProviderId(id)
    const declared = Object.entries(config.profiles ?? {})
    if (declared.length > 0) {
      for (const [profileId, profile] of declared) {
        profiles.push({
          id: toAgentProfileId(profileId),
          role: profile.role,
          providerId,
          model: profile.model,
          systemContextRef: profile.systemContextRef,
          tags: [...profile.tags],
        })
      }
      continue
    }
    for (const role of config.roles as readonly AgentRole[]) {
      profiles.push({
        id: toAgentProfileId(`${id}.${role}`),
        role,
        providerId,
        tags: [],
      })
    }
  }
  return profiles
}

function envAllowlist(allow: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of allow) {
    const value = nodeProcess.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

interface RunWiring {
  readonly workspaces: AttemptWorkspaceProvider
  readonly missionWorkspaces?: MissionWorkspaceProvider
  readonly integrator: Integrator
}

/**
 * Composition root: monta banco, stores, registry de providers, workspace provider, gate
 * runner, integrador, scheduler, relogio e ids a partir do `project.yaml` ja validado.
 * E o que a CLI e o servidor usam — nenhum deles monta pecas por conta propria.
 */
export function createControlPlane(config: ControlPlaneConfig): ControlPlane {
  const repoRoot = canonicalIfPresent(resolve(config.repoRoot ?? config.project.project.repoRoot))
  /**
   * A identidade e DERIVADA, e essa e a correcao estrutural da fatia.
   *
   * `runtimeDirOf` e a mesma conta que `projectIdentityOf` faz para a CLI e para o servidor —
   * literalmente a mesma funcao, agora em `@agentic/persistence` para que o orquestrador possa
   * chama-la sem cruzar a fronteira de camadas. Enquanto o chamador entregava `baseDir`, o
   * plane comparava o lease contra o diretorio que o CHAMADOR escolheu em vez do diretorio que
   * o REPOSITORIO determina: a chave errada, conferida com rigor.
   */
  const runtimeDir = runtimeDirOf(repoRoot)
  const lease = config.lease
  /**
   * O lease tem de proteger ESTE projeto, nao um qualquer.
   *
   * "Ter algum lease" nao e prova de posse: um lease legitimo de `/repo-A` autorizava um
   * plane aberto sobre `/repo-B`, e ai o control plane de B — que disputou a posse de B
   * corretamente — ganharia um segundo escritor sem nunca saber. A conferencia e por caminho
   * REAL, a mesma da posse, entao alias e link simbolico continuam sendo o mesmo projeto.
   */
  if (lease !== undefined && canonicalIfPresent(lease.ownedDir) !== runtimeDir) {
    throw new CommandRefusedError(
      `posse de ${lease.ownedDir} nao autoriza operar ${runtimeDir}: um lease vale para o ` +
        'projeto que ele protege, e so para ele (I14)',
    )
  }
  /**
   * AQUI esta a fronteira inteira, em duas linhas.
   *
   * Posse viva -> `readwrite`. Qualquer outra coisa -> `readonly`, e readonly nao e uma
   * convencao: e `better-sqlite3` abrindo o arquivo com `SQLITE_OPEN_READONLY`, com o kernel
   * e o proprio SQLite recusando `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE` e transacao de
   * escrita. Nao existe referencia, descriptor ou funcao capturada capaz de contornar isso,
   * porque nao ha capacidade escondida — ha uma conexao que nao escreve.
   *
   * `=== true` de proposito: `lease?.held` devolveria `undefined` sem lease, e um `undefined`
   * circulando como "talvez" e a forma exata do defeito que a 003B fechou.
   */
  const posseViva = lease?.held === true
  const mode: DatabaseMode = posseViva ? 'readwrite' : 'readonly'
  const persistence = openPersistence({ baseDir: runtimeDir, mode })
  /**
   * `access` SEGUE a posse; nao e um retrato da construcao.
   *
   * Congelado, ele afirmaria `owned` depois do `release` — com a conexao ja fechada e o
   * projeto possivelmente com outro dono. Nenhuma escrita passaria por causa disso (quem
   * recusa e a conexao), mas uma API observavel que mente sobre autoridade e um convite a
   * que o proximo chamador confie nela.
   */
  const access = (): ControlPlaneAccess => (lease?.held === true ? 'owned' : 'readonly')
  /**
   * A capacidade de escrever morre COM a posse, nao depois dela.
   *
   * Este registro e o que fecha o blocker da funcao capturada. Enquanto a revogacao dependia
   * de perguntar `held` no caminho de chamada, quem tivesse a referencia por baixo do espelho
   * escrevia; agora `release()` fecha esta conexao antes de soltar o lock do arquivo, e
   * qualquer referencia — capturada, refletida, guardada no construtor de outro objeto —
   * passa a falhar no driver. O cancelamento evita acumular gancho quando varios planes
   * atravessam a mesma posse (o `reopen` do harness).
   */
  const desregistrar = lease?.onRelease(() => persistence.close())
  /**
   * A partir daqui a conexao ja existe, entao nada pode falhar sem devolve-la.
   *
   * `loadGateProfiles` recusa um `gates.yaml` invalido e `createProviderRegistryFromProject`
   * recusa um registro mal declarado — as duas sao falhas de CONFIGURACAO, ou seja, o caso
   * comum e nao o excepcional. Sem este `try`, cada uma delas deixava um `state.db` aberto
   * por um plane que nunca chegou a existir: na CLI isso segura o arquivo ate o processo
   * sair, e num plane COM posse seria pior — o escritor ficaria vivo sem ninguem para
   * fecha-lo antes do `release`.
   */
  let montagem: {
    clock: Clock
    ids: IdGenerator
    registry: ProviderRegistry
    gates: GateProfiles
    gateRunner: GateExecutor
    profiles: AgentProfile[]
    agentEnv: Record<string, string>
  }
  try {
    const clockMontado = config.clock ?? systemClock()
    montagem = {
      clock: clockMontado,
      ids: config.ids ?? ulidGenerator({ clock: clockMontado }),
      registry:
        config.registry ??
        createProviderRegistryFromProject(config.project, {
          ...(config.scripts === undefined ? {} : { scripts: config.scripts }),
          ...(config.providerFactories === undefined
            ? {}
            : { factories: config.providerFactories }),
        }),
      gates: loadGateProfiles(config.gatesFile),
      gateRunner: config.gateRunner ?? new GateRunner(),
      profiles: profilesOf(config.project),
      agentEnv: envAllowlist(config.agentEnvAllow ?? DEFAULT_AGENT_ENV_ALLOW),
    }
  } catch (error) {
    desregistrar?.()
    persistence.close()
    throw error
  }
  const { clock, ids, registry, gates, gateRunner, profiles, agentEnv } = montagem

  const deps: ApplicationDeps = {
    store: persistence.runs,
    artifacts: persistence.artifacts,
    events: persistence.events,
    registry,
    clock,
    ids,
  }

  /**
   * I14 na pratica: MUTAR exige posse DECLARADA e ainda VIVA.
   *
   * A guarda anterior so cobrava a posse quando ela existia (`lease !== undefined && !held`),
   * e por isso lia a ausencia como permissao. Era o segundo bypass medido em 003B: um plane
   * construido sem lease — `mission approve` pelo caminho local, uma composicao esquecida,
   * um harness — criava run, aprovava missao e iniciava run no `state.db` de um projeto que
   * pertence a OUTRO processo. Nao ha meio-termo aqui: sem prova de posse, recusa.
   *
   * Sao duas perguntas diferentes, e as duas precisam de resposta:
   *
   * 1. **Este plane e dono?** Sem `lease`, ele nunca disputou nada. Quem so le nao precisa
   *    disputar, e por isso o plane sem posse continua existindo — ele apenas nao muta.
   * 2. **Ainda e?** A posse pode ter sido solta (encerramento em curso, ordem de `close`
   *    trocada) enquanto uma rota ainda tenta agir. Depois de `release`, este plane nao
   *    manda mais neste projeto, mesmo que o processo continue vivo.
   */
  const exigirPosse = (acao: string): void => {
    if (lease === undefined) {
      throw new CommandRefusedError(
        `control plane aberto sem posse do projeto: ${acao} recusado (I14)`,
      )
    }
    if (!lease.held) {
      throw new CommandRefusedError(`control plane sem posse do projeto: ${acao} recusado (I14)`)
    }
  }

  /**
   * A mesma cobranca, em forma de promessa recusada.
   *
   * `createRun`, `approveMission` e `startRun` sao declarados `Promise`, e um `throw`
   * sincrono deles escapa por fora do `.catch()` de quem chama — o erro certo, no lugar
   * errado. Recusar assincronamente mantem o contrato do tipo.
   */
  const recusarSemPosse = <T>(acao: string): Promise<T> | undefined => {
    try {
      exigirPosse(acao)
      return undefined
    } catch (error) {
      return Promise.reject(error)
    }
  }

  const orchestrators = new Map<string, Orchestrator>()
  /** Aberturas em voo, por run: o que impede dois donos nascerem em paralelo (I13). */
  const opening = new Map<string, Promise<Orchestrator>>()
  let closed = false

  const wiringFor = (mission: MissionSpec): RunWiring => {
    const execution = config.project.execution
    if (execution.workspace === 'shared') {
      return {
        workspaces: new SharedWorkspaceProvider({
          root: repoRoot,
          repoRoot,
          // Fila silenciosa travaria o tick: com uma arvore so, o segundo lease e recusado.
          onBusy: 'fail',
          workspaceSetup: execution.workspaceSetup,
        }),
        // Sem worktree nao ha segunda arvore: o gate da missao roda na unica que existe.
        missionWorkspaces: {
          acquireMission: (request) =>
            Promise.resolve({
              id: `shared/${request.attemptId}`,
              kind: 'shared' as const,
              path: repoRoot,
              leasedBy: request.attemptId,
            }),
          release: () => Promise.resolve(),
        },
        integrator: new SharedTreeIntegrator(),
      }
    }
    const provider = new GitWorktreeWorkspaceProvider({
      repoRoot,
      missionId: mission.id,
      worktreeRoot: execution.worktreeRoot,
      missionBranchPrefix: config.project.integration.missionBranchPrefix,
      taskBranchPrefix: config.project.integration.taskBranchPrefix,
      workspaceSetup: execution.workspaceSetup,
    })
    return {
      workspaces: provider,
      missionWorkspaces: {
        acquireMission: (request) =>
          provider.acquireMissionWorkspace({
            runId: request.runId,
            attemptId: request.attemptId,
            missionId: request.missionId,
          }),
        release: (workspace, disposition) => provider.release(workspace, disposition),
      },
      integrator: new GitIntegrator({
        repoRoot,
        missionId: mission.id,
        worktreeRoot: execution.worktreeRoot,
        missionBranchPrefix: config.project.integration.missionBranchPrefix,
        taskBranchPrefix: config.project.integration.taskBranchPrefix,
      }),
    }
  }

  const build = async (runId: RunId): Promise<Orchestrator> => {
    const run = await loadRun(deps, runId)
    const mission = await loadMissionSpec(deps, runId)
    if (mission === undefined) {
      throw new CommandRefusedError(
        `run ${runId} sem MissionSpec persistida: nao ha o que executar`,
      )
    }
    const wiring = wiringFor(mission)
    if (wiring.workspaces instanceof GitWorktreeWorkspaceProvider) {
      await wiring.workspaces.ensureMissionBranch(mission.id)
    }
    const engineDeps: EngineDeps = {
      store: persistence.runs,
      artifacts: persistence.artifacts,
      workspaces: wiring.workspaces,
      missionWorkspaces: wiring.missionWorkspaces,
      integrator: wiring.integrator,
      gates,
      gateRunner,
      registry,
      events: persistence.events,
      clock,
      ids,
      mission,
      executorProfiles: profiles.filter((profile) => profile.role === 'executor'),
      reviewerProfiles: profiles.filter((profile) => profile.role === 'reviewer'),
      projectReviewPolicy: {
        byRisk: config.project.policies.review.byRisk,
        default: config.project.policies.review.default,
      },
      missionGateId: run.missionGateId,
      agentEnv,
      ...(config.agentLog === undefined ? {} : { agentLog: config.agentLog }),
      safetyIntervalMs: config.safetyIntervalMs,
    }
    return new Orchestrator(engineDeps, runId)
  }

  /**
   * UM orquestrador por run nesta instancia (I13), inclusive sob chamadas concorrentes.
   *
   * Guardar a INSTANCIA nao bastava: entre consultar o mapa e povoa-lo, `build` atravessa
   * varios `await` (banco, artefato, `ensureMissionBranch`), e duas chamadas simultaneas
   * — a adocao do boot e uma rota HTTP, por exemplo, ja que a API atende antes de a adocao
   * terminar — construiriam dois donos, com o segundo sobrescrevendo o primeiro no mapa e
   * o primeiro seguindo vivo e invisivel. Guardar a PROMESSA fecha a janela: a segunda
   * chamada espera a primeira em vez de comecar outra.
   */
  const open = (runId: RunId): Promise<Orchestrator> => {
    // Depois de `close` nao ha banco para abrir contra: recusar e melhor que devolver um
    // dono que so vai falhar no primeiro tick.
    if (closed) {
      return Promise.reject(new CommandRefusedError('control plane encerrado: nada a abrir'))
    }
    const semPosse = recusarSemPosse<Orchestrator>(`abrir orquestrador do run ${runId}`)
    if (semPosse !== undefined) return semPosse
    const existing = orchestrators.get(runId)
    if (existing !== undefined) return Promise.resolve(existing)
    const pending = opening.get(runId)
    if (pending !== undefined) return pending
    const promise = build(runId)
      .then((orchestrator) => {
        orchestrators.set(runId, orchestrator)
        return orchestrator
      })
      // Falha nao deixa a promessa presa no mapa: a proxima chamada tenta de novo.
      .finally(() => opening.delete(runId))
    opening.set(runId, promise)
    return promise
  }

  /**
   * I13: depois do boot, todo run em `RECOVERABLE_ACTIVE_RUN_STATUSES` tem UM orquestrador
   * vivo COM O LOOP LIGADO nesta instancia.
   *
   * `open` sozinho nao serve. Ele cria o dono, mas deixa `#autoTick` desligado: e por isso
   * que hoje um `resume` depois de um reinicio despacha trabalho num tick unico e nunca
   * colhe o resultado. Quem adota tem de ligar o loop — por isso `start()`.
   *
   * Adotar nao RETOMA trabalho de agente: o primeiro tick comeca por `#reconcile`, que
   * ENCERRA como `INTERRUPTED` o que ficou em voo em vez de continua-lo. O despacho so vem
   * depois, sobre estado limpo, como tentativa nova cobrada do orcamento (I4). O mission
   * gate e excecao declarada — sem marcador duravel de inicio, uma execucao interrompida e
   * refeita do zero. Isso e seguro porque o gate MEDE um commit em vez de mudar o
   * repositorio (ver STATE-MACHINES, I13).
   *
   * Um run recuperavel que nao abre (MissionSpec ausente, worktree ocupada) nao derruba o
   * boot nem os outros: vira recusa registrada. Entre PROCESSOS, quem garante que so existe
   * um adotante e a posse do projeto (I14): sem ela, esta funcao recusa.
   */
  const adoptRecoverableRuns = async (): Promise<AdoptionResult> => {
    // Somente o dono adota. Dois processos adotando o mesmo run foi o dano medido em D4:
    // duas worktrees no mesmo caminho e tentativas descartadas por transicao invalida.
    exigirPosse('adotar runs recuperaveis')
    const adopted: RunAdoption[] = []
    const refused: RunAdoptionRefusal[] = []
    const rows = persistence.queries.listRuns({ status: [...RECOVERABLE_ACTIVE_RUN_STATUSES] })
    for (const row of rows) {
      if (!isRunId(row.id) || !isRunStatus(row.status)) continue
      const runId = row.id
      // Lido ANTES de `open`, que e quem cria: depois da chamada todo run parece ja possuido.
      const alreadyOwned = orchestrators.has(runId) || opening.has(runId)
      try {
        const orchestrator = await open(runId)
        // A linha da consulta e um retrato; abrir leva varios `await` e a API ja atende.
        // Um `stop` no meio do caminho torna o run terminal, e ligar um loop para ele
        // seria manter um timer aceso sobre trabalho que ninguem mais quer.
        const atual = await deps.store.loadRun(runId)
        const status = atual?.status ?? row.status
        if (atual === undefined || !isRecoverableActiveRunStatus(status)) {
          refused.push({
            runId,
            status,
            reason: `run deixou de ser recuperavel durante a adocao (${status})`,
          })
          continue
        }
        orchestrator.start()
        adopted.push({ runId, status, alreadyOwned })
      } catch (error) {
        refused.push({
          runId,
          status: row.status,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { adopted, refused }
  }

  return {
    persistence,
    get access(): ControlPlaneAccess {
      return access()
    },
    ...(lease === undefined ? {} : { instanceId: lease.instanceId }),
    registry,
    gates,
    clock,
    ids,
    deps,
    validateMission,
    compileMission,
    // Estas tres escrevem estado sem passar por `open`, entao cobram a guarda por conta
    // propria — e cobram a MESMA guarda: num plane sem posse declarada elas recusam, como
    // `open` e `adoptRecoverableRuns`. Foi por aqui que `mission approve` mutava o projeto
    // de outro processo (003B).
    createRun: (input) =>
      recusarSemPosse<Run>('criar run') ??
      createRun(deps, { ...input, project: input.project ?? config.project }),
    approveMission: (input) =>
      recusarSemPosse<Run>('aprovar missao') ?? approveMission(deps, input),
    startRun: (input) => recusarSemPosse<Run>('iniciar run') ?? startRun(deps, input),
    pauseRun: async (runId, command) => pauseRun(await open(runId), command),
    resumeRun: async (runId, command) => resumeRun(await open(runId), command),
    stopRun: async (runId, command) => stopRun(await open(runId), command),
    unblockTask: async (runId, command) => unblockTask(await open(runId), command),
    retryTask: async (runId, command) => retryTask(await open(runId), command),
    skipTask: async (runId, command) => skipTask(await open(runId), command),
    cancelTask: async (runId, command) => (await open(runId)).cancelTask(command),
    getRunSnapshot: (runId) => getRunSnapshot(deps, runId),
    getTaskDetail: (runId, taskId) => getTaskDetail(deps, runId, taskId),
    generateMissionReport: (runId) => generateMissionReport(deps, runId),
    open,
    adoptRecoverableRuns,
    close: async () => {
      // Fechar sem olhar para `opening` deixava a pior sobra possivel: uma abertura
      // iniciada antes do fechamento terminava depois, povoava o mapa ja limpo e entregava
      // ao chamador um dono vivo sobre um banco fechado. Barrar novas aberturas e esperar
      // as em voo custa um `await`; o oposto custa um orquestrador fantasma.
      closed = true
      const emVoo = await Promise.allSettled([...opening.values()])
      for (const aberto of emVoo) {
        if (aberto.status === 'fulfilled') await aberto.value.abandon().catch(() => undefined)
      }
      opening.clear()
      for (const orchestrator of orchestrators.values()) await orchestrator.abandon()
      orchestrators.clear()
      // Fechar e devolver recurso, nao escrever estado — e depois de fechar nao ha mais o
      // que o lease precise revogar, entao o gancho sai junto em vez de envelhecer nele.
      desregistrar?.()
      persistence.close()
    },
  }
}

export type { CompiledGraph }
