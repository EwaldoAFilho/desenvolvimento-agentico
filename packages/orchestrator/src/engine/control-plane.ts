import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import nodeProcess from 'node:process'
import type { CompiledGraph } from '@agentic/compiler'
import {
  type AgentProfile,
  type AgentRole,
  type Clock,
  type IdGenerator,
  type Integrator,
  isMissionId,
  isRecoverableActiveRunStatus,
  isRunId,
  isRunStatus,
  type MissionId,
  type MissionPlanner,
  type MissionPlannerRegistry,
  type MissionSpec,
  type ProviderRegistry,
  RECOVERABLE_ACTIVE_RUN_STATUSES,
  type Run,
  type RunId,
  type RunStatus,
  type TaskId,
  agentProfileId as toAgentProfileId,
  missionId as toMissionId,
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
import type { GroupProbeDeps } from '@agentic/process'
import {
  BUILT_IN_PLANNER_DESCRIPTORS,
  createMissionPlannerRegistry,
  createProviderRegistryFromProject,
  LocalCliMissionPlanner,
  type MockScript,
  type ProviderFactory,
} from '@agentic/providers'
import type { GatesFile, ProjectFile, RunSnapshot, TaskDetail } from '@agentic/schemas'
import { parseMissionFile } from '@agentic/schemas'
import {
  GitIntegrator,
  GitWorktreeWorkspaceProvider,
  git,
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
  DEFAULT_PLANNING_TIMEOUT_MS,
  generateMissionReport,
  getRunSnapshot,
  getTaskDetail,
  loadMissionSpec,
  loadRun,
  type MissionArtifactStore,
  MissionFileExistsError,
  type MissionReport,
  type PlanMissionInput,
  type PlanMissionResult,
  type PlanningDeps,
  type ProjectSourceText,
  pauseRun,
  planMission,
  type RepoObserver,
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
  type AbandonOptions,
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

/** Onde as missoes do projeto moram, dentro do `baseDir`. */
const DEFAULT_MISSIONS_DIR = 'missions'

const MISSION_FILE_SUFFIX = '.mission.yaml'
const MISSION_FILE_SUFFIXES = ['.yaml', '.yml']

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
  /**
   * Conteudo BRUTO do project.yaml e do gates.yaml. Compilar e funcao pura sobre texto
   * (ARCHITECTURE 7), e planejar compila a proposta antes de gravar qualquer coisa. Ausentes,
   * o control plane le os dois do disco na primeira vez que precisar.
   */
  readonly projectText?: string
  readonly gatesText?: string
  /** Onde o artefato da missao e gravado. Default: `<runtimeDir>/missions`. */
  readonly missionsDir?: string
  /** Planejadores disponiveis. Ausente: os derivados das CLIs declaradas no projeto. */
  readonly planners?: MissionPlannerRegistry
  readonly planningTimeoutMs?: number
  readonly clock?: Clock
  readonly ids?: IdGenerator
  readonly registry?: ProviderRegistry
  /** Roteiros dos providers in-process, por id — o caminho de teste sem LLM. */
  readonly scripts?: Readonly<Record<string, MockScript>>
  /** Substitui a construcao de um provider — usado pela suite para roteiros por tentativa. */
  readonly providerFactories?: Readonly<Record<string, ProviderFactory>>
  readonly gateRunner?: GateExecutor
  /**
   * Sonda do grupo de processos, compartilhada por gate runner, `workspaceSetup` e pela
   * re-sonda de residuos do orquestrador. Default: a sonda real do sistema. Injetavel porque
   * um grupo que sobrevive a SIGKILL nao se fabrica de forma portavel em teste.
   */
  readonly processProbe?: GroupProbeDeps
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

/** Prazo padrao para os efeitos de um plane pararem no `close` (I15). */
export const DEFAULT_SHUTDOWN_GRACE_MS = 30_000

export type CloseOptions = AbandonOptions

/**
 * Onde o plane esta no proprio ciclo de vida.
 *
 * `open`: aceita trabalho. `closing`: recusa trabalho novo e esta drenando o que ja comecou —
 * e fica aqui se a drenagem falhar, para que um `close` seguinte tente de novo em vez de
 * fingir que terminou. `closed`: nenhum efeito deste plane pode mais mutar o projeto.
 */
export type ControlPlaneLifecycle = 'open' | 'closing' | 'closed'

export interface ControlPlane {
  readonly persistence: Persistence
  /**
   * O que este plane e: `owned` escreve, `readonly` so le. Nao ha semantica implicita —
   * quem recebe um plane pronto pode PERGUNTAR em vez de deduzir da presenca de um lease.
   */
  readonly access: ControlPlaneAccess
  readonly lifecycle: ControlPlaneLifecycle
  /** Identidade do dono, quando este plane tem posse. Liga a posse a descoberta. */
  readonly instanceId?: string
  readonly registry: ProviderRegistry
  /**
   * Quem sabe propor missao. Lista vazia e resposta legitima: nem todo projeto declara uma
   * CLI que saiba planejar.
   *
   * Opcional no CONTRATO, e nunca em `createControlPlane`: existe implementacao parcial de
   * `ControlPlane` fora deste pacote, e exigir planejamento de quem so precisa despachar
   * task quebraria essas implementacoes sem ganho. Quem consome recusa explicitamente
   * quando falta, em vez de assumir que existe.
   */
  readonly planners?: MissionPlannerRegistry
  readonly gates: GateProfiles
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly deps: ApplicationDeps
  validateMission(input: CompileInput): ReturnType<typeof validateMission>
  compileMission(input: CompileInput): CompileResult
  createRun(input: Omit<CreateRunInput, 'project'> & { project?: ProjectFile }): Promise<Run>
  /** Ver `planners`: opcional pelo mesmo motivo, e sempre presente em `createControlPlane`. */
  planMission?(input: PlanMissionInput): Promise<PlanMissionResult>
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
  /**
   * Primeira fase do encerramento, separada para poder acontecer ANTES de o servidor parar
   * de atender: daqui em diante `open`, `createRun`, `approveMission`, `startRun` e
   * `adoptRecoverableRuns` recusam. Uma requisicao HTTP ja em voo que chegue a uma dessas
   * chamadas recebe a recusa em vez de criar trabalho novo no meio da drenagem (I15).
   * Idempotente; `close` continua sendo quem drena e fecha.
   */
  quiesce(): void
  /**
   * Encerra ESTE plane (I15): recusa trabalho novo, cancela o que e cancelavel, espera o que
   * ja comecou, registra o que chegou, e so entao fecha o banco. Se algum efeito nao parar
   * dentro do prazo, REJEITA com `ShutdownTimeoutError` e deixa o banco aberto — quem
   * chama nao devolve a posse nesse caso. Idempotente e seguro sob chamadas concorrentes.
   */
  close(options?: CloseOptions): Promise<void>
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

// --------------------------------------------------------------------------------------
// Planejamento: quem pode propor, onde o artefato mora, como o repositorio e observado
// --------------------------------------------------------------------------------------

/**
 * Planejadores derivados das CLIs que o projeto declara. So entra a CLI para a qual
 * conhecemos um modo nao interativo de LEITURA: pedir plano a uma CLI cujo modo de leitura
 * desconhecemos seria adivinhar permissao de escrita, e planejar nao escreve.
 *
 * Provider in-process nao vira planejador — simulador nao se apresenta como planejamento de
 * verdade (ADR-0016 4). Planejador simulado entra por `config.planners`, nomeado como tal.
 */
function plannersOf(project: ProjectFile): MissionPlannerRegistry {
  const planners: MissionPlanner[] = []
  for (const [id, config] of Object.entries(project.providers.registry)) {
    if (config.kind !== 'local-cli') continue
    const descriptor = BUILT_IN_PLANNER_DESCRIPTORS[id]
    if (descriptor === undefined) continue
    planners.push(
      new LocalCliMissionPlanner(descriptor, {
        id: toProviderId(id),
        ...(config.command === undefined ? {} : { command: config.command }),
        ...(config.versionArgs === undefined ? {} : { versionArgs: config.versionArgs }),
      }),
    )
  }
  const preferred = project.providers.default
  const isPlanner = planners.some((planner) => String(planner.id) === preferred)
  return createMissionPlannerRegistry({
    planners,
    ...(isPlanner ? { default: toProviderId(preferred) } : {}),
  })
}

/** Id da missao pelo NOME do arquivo. `DA-UX-001.mission.yaml` -> `DA-UX-001`. */
function missionIdOfFile(name: string): MissionId | undefined {
  const suffix = MISSION_FILE_SUFFIXES.find((item) => name.endsWith(item))
  if (suffix === undefined) return undefined
  const base = name.slice(0, -suffix.length)
  const id = base.endsWith('.mission') ? base.slice(0, -'.mission'.length) : base
  return isMissionId(id) ? id : undefined
}

function posix(path: string): string {
  return path.split(sep).join('/')
}

/**
 * O artefato da missao em disco. `create` usa `wx`: se o arquivo ja existe, o sistema de
 * arquivos recusa — nao ha janela entre conferir e gravar em que outro pedido pudesse
 * sobrescrever o plano de alguem.
 */
function missionArtifactStore(repoRoot: string, missionsDir: string): MissionArtifactStore {
  const fileOf = (id: MissionId): string => join(missionsDir, `${id}${MISSION_FILE_SUFFIX}`)
  return {
    pathFor: (id) => posix(relative(repoRoot, fileOf(id))),
    /**
     * Nome do arquivo E id declarado dentro dele: um plano gravado com outro nome continua
     * ocupando o id, e propor esse id daria colisao so na hora de compilar.
     */
    taken: async (): Promise<readonly MissionId[]> => {
      let entries: string[]
      try {
        entries = await readdir(missionsDir)
      } catch {
        // Diretorio ausente e projeto sem missao — o estado normal de quem acabou de comecar.
        return []
      }
      const taken = new Set<string>()
      for (const name of entries) {
        const fromName = missionIdOfFile(name)
        if (fromName !== undefined) taken.add(fromName)
        if (!MISSION_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue
        const text = await readFile(join(missionsDir, name), 'utf8').catch(() => undefined)
        if (text === undefined) continue
        const parsed = parseMissionFile(text)
        if (parsed.ok) taken.add(parsed.value.id)
      }
      return [...taken].sort().map((id) => toMissionId(id))
    },
    create: async (id, text): Promise<void> => {
      const path = fileOf(id)
      await mkdir(dirname(path), { recursive: true })
      try {
        await writeFile(path, text, { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (code === 'EEXIST') throw new MissionFileExistsError(posix(relative(repoRoot, path)))
        throw error
      }
    },
  }
}

/**
 * O que o control plane consegue MEDIR do repositorio sem alterar nada: o commit atual e o
 * que o git ve de diferente dele. Duas leituras iguais em volta da chamada do planejador sao
 * a evidencia de que planejar nao alterou arquivo.
 *
 * LIMITE CONHECIDO, registrado em vez de escondido: `git diff HEAD` compara conteudo DEPOIS
 * dos filtros do git. Com `.gitattributes` declarando `text`, trocar LF por CRLF (ou o
 * contrario) nao aparece em lugar nenhum — para o git aquilo nao e mudanca. Uma alteracao
 * so de fim de linha em arquivo normalizado passa despercebida aqui.
 *
 * Nao e defeito desta funcao: e o significado de "mudou" que o proprio git define. Fechar
 * exigiria hashear bytes do disco de todo arquivo rastreado a cada leitura, em toda chamada
 * de planejamento, e o custo nao paga o cenario. Fica dito, e vale lembrar o modelo do
 * produto: verificado, nao confinado. Esta digital detecta alteracao comum; ela nao e
 * barreira contra processo adversarial — quem consegue rodar `git update-index` tambem
 * consegue commitar.
 *
 * Somente conteudo versionado — arquivo ignorado fica de fora de proposito: `.agentic/` e o
 * banco do proprio control plane mudam durante o planejamento, e cobra-los aqui trocaria a
 * garantia por um alarme permanente. Sem git nao ha observacao, e ausencia de observacao nao
 * vale como prova: o caso de uso recusa em vez de afirmar o que nao mediu.
 */
export function gitRepoObserver(repoRoot: string): RepoObserver {
  return {
    fingerprint: async (): Promise<string | undefined> => {
      try {
        const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
          cwd: repoRoot,
          stage: 'diff',
        })
        // Repositorio sem nenhum commit nao tem HEAD, e isso nao impede a comparacao.
        const head = await git(['rev-parse', 'HEAD'], {
          cwd: repoRoot,
          allowFailure: true,
          stage: 'diff',
        })
        // `status` diz NOME e ESTADO, nunca conteudo: um arquivo que ja estava modificado
        // continua saindo como ` M caminho` depois de ser reescrito, e um nao rastreado
        // continua saindo como `?? caminho`. So com isso, o planejador poderia sobrescrever
        // qualquer um dos dois sem mover a impressao digital — e a garantia de "nada mudou
        // alem do artefato da missao" seria vazia justamente onde ha trabalho em andamento.
        //
        // O conteudo entra por dois caminhos que NAO alteram o indice: o patch do que ja e
        // rastreado, e o hash do que ainda nao e. `--intent-to-add` resolveria os dois de
        // uma vez, mas escreve no indice, e observar nao pode alterar o que observa.
        // `assume-unchanged` e `skip-worktree` mandam o git IGNORAR alteracao no arquivo:
        // com o bit ligado, status e diff HEAD ficam vazios mesmo com o conteudo mudado.
        //
        // Nao basta incluir os bits na digital. Se o bit ja estiver ligado ANTES da primeira
        // leitura, as duas digitais nascem iguais e a alteracao no meio fica invisivel do
        // mesmo jeito. Com o bit ligado o git simplesmente NAO consegue reportar mudanca
        // naquele arquivo — entao nao ha observacao a ser feita, e a resposta honesta e
        // recusar, como em todo o resto deste observador.
        //
        // `ls-files -v` marca assume-unchanged com letra MINUSCULA e skip-worktree com `S`.
        const flags = await git(['ls-files', '-v'], {
          cwd: repoRoot,
          allowFailure: true,
          stage: 'diff',
        })
        if (flags.exitCode !== 0) return undefined
        const ocultos = flags.stdout
          .split('\n')
          .filter((linha) => linha.length > 1)
          .some((linha) => {
            const marca = linha[0] ?? ''
            return marca === 'S' || (marca >= 'a' && marca <= 'z')
          })
        if (ocultos) return undefined
        const patch = await git(['diff', 'HEAD', '--no-ext-diff', '--no-color'], {
          cwd: repoRoot,
          allowFailure: true,
          stage: 'diff',
        })
        const untracked = status.stdout
          .split('\0')
          .filter((entry) => entry.startsWith('?? '))
          .map((entry) => entry.slice(3))
          .filter((path) => path.length > 0)
          .sort()
        // A lista de caminhos vai por STDIN, nao por argv: argv tem teto de tamanho no
        // sistema operacional (32.767 caracteres no Windows) e nenhum lote finito resolve um
        // caminho unico grande demais. `--stdin-paths` tira o problema da equacao.
        //
        // `--stdin-paths` nao aceita qualquer byte: separa por quebra de linha, LE linha
        // iniciada por aspas como C-quoted, e descarta `\r` no fim. Um nome com qualquer
        // dessas formas seria lido como OUTRO caminho — e o git responderia exit 0, com a
        // contagem certa, hasheando o arquivo errado. Alteracao invisivel com aparencia de
        // observacao completa e pior que recusa, entao esses nomes recusam: e a mesma
        // doutrina do resto deste observador — ausencia de observacao nao vale prova.
        // U+FFFD num caminho significa uma de duas coisas, e nenhuma permite prosseguir: ou
        // o nome no disco tem bytes que nao sao UTF-8 e o wrapper do git os destruiu na
        // decodificacao, ou o arquivo se chama assim mesmo. No primeiro caso a string nao
        // aponta mais para o arquivo certo — e pode apontar para OUTRO, rastreado ou nao,
        // fazendo `hash-object` sair 0 sobre o arquivo errado e escondendo a alteracao.
        // Distinguir os dois casos exigiria o helper git devolver bytes em vez de string,
        // o que atinge toda chamada git do produto e e mudanca de outra missao. Aqui a
        // resposta honesta e recusar a observacao inteira.
        const irrepresentavel = (caminho: string): boolean =>
          caminho.includes('\n') ||
          caminho.includes('\r') ||
          caminho.startsWith('"') ||
          caminho.includes('\uFFFD')
        let contents = ''
        if (untracked.length > 0) {
          if (untracked.some(irrepresentavel)) return undefined
          // O wrapper do git decodifica em UTF-8, entao um nome POSIX com bytes invalidos
          // vira U+FFFD. Se existir tambem um arquivo chamado literalmente com esse
          // caractere, os dois viram a MESMA string: `--stdin-paths` hashearia o segundo
          // duas vezes, com exit 0 e contagem certa, e alteracao no primeiro ficaria
          // invisivel. Nome repetido depois da decodificacao e prova de que a lista nao
          // representa mais o disco — entao recusa.
          if (new Set(untracked).size !== untracked.length) return undefined
          const hashes = await git(['hash-object', '--stdin-paths'], {
            cwd: repoRoot,
            allowFailure: true,
            stage: 'diff',
            stdin: `${untracked.join('\n')}\n`,
          })
          const saida = hashes.stdout.split('\n').filter((linha) => linha.length > 0)
          // Hash que faltou nao pode virar `?`: devolveria impressao digital DEFINIDA sem ter
          // observado o conteudo, e uma reescrita ficaria invisivel — exatamente o defeito
          // que esta funcao existe para fechar.
          if (hashes.exitCode !== 0 || saida.length !== untracked.length) return undefined
          contents = untracked.map((caminho, i) => `${caminho} ${saida[i]}`).join('\n')
        }
        return [head.stdout.trim(), status.stdout, flags.stdout, patch.stdout, contents].join(
          '\n---\n',
        )
      } catch {
        return undefined
      }
    },
  }
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
      gateRunner:
        config.gateRunner ??
        new GateRunner(
          config.processProbe === undefined ? {} : { processDeps: config.processProbe },
        ),
      profiles: profilesOf(config.project),
      agentEnv: envAllowlist(config.agentEnvAllow ?? DEFAULT_AGENT_ENV_ALLOW),
    }
  } catch (error) {
    desregistrar?.()
    persistence.close()
    throw error
  }
  const { clock, ids, registry, gates, gateRunner, profiles, agentEnv } = montagem

  const planners = config.planners ?? plannersOf(config.project)
  const missionsDir = resolve(
    repoRoot,
    config.missionsDir ?? join(runtimeDir, DEFAULT_MISSIONS_DIR),
  )

  /**
   * O TEXTO dos dois arquivos, nao o objeto ja validado: compilar a proposta e funcao pura
   * sobre conteudo. Quando o chamador nao os entrega, sao lidos do disco uma vez e guardados
   * — reler a cada correcao faria o projeto mudar no meio do ciclo de reparo.
   */
  let sources: ProjectSourceText | undefined =
    config.projectText === undefined || config.gatesText === undefined
      ? undefined
      : { projectText: config.projectText, gatesText: config.gatesText }

  const loadSources = async (): Promise<ProjectSourceText> => {
    if (sources !== undefined) return sources
    const gatesPath = isAbsolute(config.project.gates.file)
      ? config.project.gates.file
      : resolve(repoRoot, config.project.gates.file)
    const projectPath = join(runtimeDir, 'project.yaml')
    try {
      const [projectText, gatesText] = await Promise.all([
        readFile(projectPath, 'utf8'),
        readFile(gatesPath, 'utf8'),
      ])
      sources = { projectText, gatesText }
      return sources
    } catch (error) {
      throw new CommandRefusedError(
        `nao foi possivel ler a configuracao do projeto para compilar a proposta: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const planningDeps: PlanningDeps = {
    planners,
    missions: missionArtifactStore(repoRoot, missionsDir),
    repo: gitRepoObserver(repoRoot),
    sources: loadSources,
    project: config.project,
    gates: gates.ids,
    readRoot: repoRoot,
    timeoutMs: config.planningTimeoutMs ?? DEFAULT_PLANNING_TIMEOUT_MS,
  }

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
    // Encerrando ou encerrado, este plane nao aceita trabalho novo — antes mesmo de olhar
    // a posse. E a primeira fase do encerramento: parar de aceitar (I15).
    if (closed) {
      throw new CommandRefusedError(
        `control plane ${lifecycle === 'closed' ? 'encerrado' : 'encerrando'}: ${acao} recusado`,
      )
    }
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
  let lifecycle: ControlPlaneLifecycle = 'open'
  /** O `close` em curso: chamadas concorrentes compartilham a mesma drenagem. */
  let closing: Promise<void> | undefined

  const setupProbe =
    config.processProbe === undefined ? {} : { setupProcessDeps: config.processProbe }
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
          ...setupProbe,
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
      ...setupProbe,
    })
    return {
      workspaces: provider,
      missionWorkspaces: {
        acquireMission: (request) =>
          provider.acquireMissionWorkspace({
            runId: request.runId,
            attemptId: request.attemptId,
            missionId: request.missionId,
            // O sinal de encerramento tem de chegar ao `workspaceSetup` da worktree da missao.
            ...(request.signal === undefined ? {} : { signal: request.signal }),
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
      processProbe: config.processProbe,
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
    // dono que so vai falhar no primeiro tick. Durante o `close`, idem: abrir seria aceitar
    // trabalho novo no meio da drenagem.
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

  /**
   * A ordem do encerramento E a garantia (I15), e ela vive aqui com um motivo por passo:
   *
   * 1. `closed = true` primeiro: nenhuma abertura, criacao, aprovacao, partida ou adocao
   *    nova passa daqui. Aberturas em voo sao esperadas — uma que terminasse depois povoaria
   *    o mapa ja limpo com um dono vivo sobre banco fechado.
   * 2. Cada orquestrador e abandonado: cancela o que e cancelavel, espera a cadeia do tick e
   *    os efeitos assincronos, e colhe os resultados que ja chegaram. Com PRAZO. Um que nao
   *    pare dentro dele faz o `close` inteiro falhar — e o banco fica ABERTO, porque fecha-lo
   *    por baixo de um efeito vivo so trocaria "efeito em voo" por "efeito em voo que falha
   *    no ultimo passo". O chamador nao devolve a posse nesse caso, e um `close` seguinte
   *    tenta de novo.
   * 3. As escritas de artefato em voo terminam (`settle`) antes de o banco fechar: sao o unico
   *    efeito da persistencia com metade fora do banco.
   * 4. So entao a conexao fecha e o gancho sai do lease.
   */
  /** Planejamentos em voo: efeito com processo filho (a CLI do planejador) — entra na drenagem. */
  const planningInFlight = new Set<Promise<unknown>>()
  const trackPlanning = (work: Promise<PlanMissionResult>): Promise<PlanMissionResult> => {
    const tracked: Promise<unknown> = work.then(
      () => undefined,
      () => undefined,
    )
    planningInFlight.add(tracked)
    void tracked.finally(() => planningInFlight.delete(tracked))
    return work
  }

  /**
   * Planejamento em voo no `close` (I15): o planejador que souber cancelar e cancelado (a CLI
   * recebe SIGTERM e o caso de uso devolve PLANNER_CANCELLED sem gravar nada); depois
   * espera-se o caso de uso assentar, com o MESMO prazo dos orquestradores. Vencido o prazo
   * com planejamento vivo, o `close` falha e a posse nao e devolvida — igual a um
   * orquestrador que nao drena.
   */
  const drainPlanning = async (options: CloseOptions): Promise<void> => {
    if (planningInFlight.size === 0) return
    const graceMs = options.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), graceMs)
      timer.unref?.()
    })
    /**
     * Cancelar E esperar assentar, os dois dentro do MESMO prazo. O `cancel()` do planejador
     * so resolve com o grupo de processos provado morto: uma rejeicao (PROCESS_GROUP_ALIVE)
     * e um efeito vivo, e efeito vivo segura a posse — nao e engolida.
     */
    const cancelAll = async (): Promise<void> => {
      const falhas: unknown[] = []
      for (const id of planners.list()) {
        const planner = planners.get(id) as { cancel?: (reason: string) => Promise<void> }
        if (typeof planner.cancel !== 'function') continue
        try {
          await planner.cancel('control plane encerrando')
        } catch (error) {
          falhas.push(error)
        }
      }
      if (falhas.length > 0) {
        throw new CommandRefusedError(
          `planejador com processo ainda vivo apos o cancelamento: ${falhas
            .map((f) => (f instanceof Error ? f.message : String(f)))
            .join('; ')} — a posse nao pode ser devolvida (I15)`,
        )
      }
      await Promise.allSettled([...planningInFlight])
    }
    const settled = await Promise.race([cancelAll().then(() => 'settled' as const), deadline])
    if (timer !== undefined) clearTimeout(timer)
    if (settled === 'timeout') {
      throw new CommandRefusedError(
        `${planningInFlight.size} planejamento(s) em voo nao encerraram em ${graceMs}ms: a posse nao pode ser devolvida (I15)`,
      )
    }
  }

  const closeAll = async (options: CloseOptions): Promise<void> => {
    closed = true
    lifecycle = 'closing'
    await drainPlanning(options)
    const emVoo = await Promise.allSettled([...opening.values()])
    for (const aberto of emVoo) {
      if (aberto.status === 'fulfilled') orchestrators.set(aberto.value.runId, aberto.value)
    }
    opening.clear()
    const falhas: unknown[] = []
    for (const orchestrator of [...orchestrators.values()]) {
      try {
        await orchestrator.abandon(options)
        orchestrators.delete(orchestrator.runId)
      } catch (error) {
        falhas.push(error)
      }
    }
    if (falhas.length > 0) {
      const primeira = falhas[0]
      if (falhas.length === 1 && primeira instanceof Error) throw primeira
      throw new AggregateError(
        falhas,
        `${falhas.length} orquestrador(es) nao encerraram dentro do prazo: a posse nao pode ser devolvida (I15)`,
      )
    }
    await persistence.settle()
    // Fechar e devolver recurso, nao escrever estado — e depois de fechar nao ha mais o
    // que o lease precise revogar, entao o gancho sai junto em vez de envelhecer nele.
    desregistrar?.()
    persistence.close()
    lifecycle = 'closed'
  }

  return {
    persistence,
    get access(): ControlPlaneAccess {
      return access()
    },
    get lifecycle(): ControlPlaneLifecycle {
      return lifecycle
    },
    quiesce: (): void => {
      if (lifecycle !== 'open') return
      closed = true
      lifecycle = 'closing'
    },
    ...(lease === undefined ? {} : { instanceId: lease.instanceId }),
    registry,
    planners,
    gates,
    clock,
    ids,
    deps,
    validateMission,
    compileMission,
    // Estas escrevem estado sem passar por `open`, entao cobram a guarda por conta
    // propria — e cobram a MESMA guarda: num plane sem posse declarada elas recusam, como
    // `open` e `adoptRecoverableRuns`. Foi por aqui que `mission approve` mutava o projeto
    // de outro processo (003B). Planejar tambem escreve (o artefato da missao e o rascunho).
    createRun: (input) =>
      recusarSemPosse<Run>('criar run') ??
      createRun(deps, { ...input, project: input.project ?? config.project }),
    planMission: (input) =>
      recusarSemPosse<PlanMissionResult>('planejar missao') ??
      trackPlanning(planMission(deps, planningDeps, input)),
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
    close: (options = {}) => {
      if (lifecycle === 'closed') return Promise.resolve()
      // Chamadas concorrentes compartilham a MESMA drenagem; uma que falhe libera o lugar
      // para a proxima tentar de novo, em vez de repetir a rejeicao para sempre.
      closing ??= closeAll(options).catch((error: unknown) => {
        closing = undefined
        throw error
      })
      return closing
    },
  }
}

export type { CompiledGraph }
