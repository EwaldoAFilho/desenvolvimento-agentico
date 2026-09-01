import {
  acquireControlPlaneOwnership,
  type ControlPlaneLease,
  newInstanceId,
} from '@agentic/persistence'
import { type ControlPlaneRuntime, readControlPlaneFile } from './control-plane-file.js'

/**
 * O passo de posse do boot (I14).
 *
 * Existe para responder UMA pergunta, antes de qualquer outra coisa acontecer: este processo
 * pode ser o dono deste projeto? Enquanto ela nao for respondida, nada e aberto, nada e
 * migrado, nada e adotado e nenhum agente e despachado.
 */
export class ControlPlaneBusyError extends Error {
  readonly code = 'OWNERSHIP_ALREADY_HELD'
  readonly lockPath: string
  readonly ownedDir: string
  /** Onde falar com o dono, quando ele ja publicou o endereco. Pode faltar — e so descoberta. */
  readonly owner: ControlPlaneRuntime | undefined

  constructor(input: {
    readonly lockPath: string
    readonly ownedDir: string
    readonly owner: ControlPlaneRuntime | undefined
    readonly detail: string
  }) {
    super(
      input.owner === undefined
        ? `${input.detail}; nenhum endereco publicado ainda em ${input.ownedDir}`
        : `${input.detail}; control plane no ar em ${input.owner.url} (pid ${input.owner.pid})`,
    )
    this.name = 'ControlPlaneBusyError'
    this.lockPath = input.lockPath
    this.ownedDir = input.ownedDir
    this.owner = input.owner
  }
}

export interface OwnershipStepInput {
  /**
   * O diretorio de ESTADO do projeto — `<repoRoot>/.agentic`, ja pela conta unica de
   * `projectIdentityOf`. E ele, e so ele, que a posse protege.
   *
   * Receber o diretorio pronto em vez de deriva-lo aqui e a correcao de 003B: quando cada
   * chamador derivava o seu, `serve` e `mission start` chegavam a chaves diferentes sobre o
   * mesmo projeto e viravam dois donos.
   */
  readonly runtimeDir: string
  /** Injetavel para o teste; por padrao um identificador novo por processo. */
  readonly instanceId?: string
  readonly busyTimeoutMs?: number
}

/**
 * Posse do projeto ou recusa com o dono vivo no motivo.
 *
 * A chave e o `<repoRoot>/.agentic` canonicalizado — o diretorio que guarda o `state.db`.
 * Nao e a porta: `--port` nao compra posse, e dois enderecos diferentes sobre o mesmo
 * projeto continuam sendo dois donos do mesmo banco (D4).
 */
export async function claimControlPlane(input: OwnershipStepInput): Promise<ControlPlaneLease> {
  const runtimeDir = input.runtimeDir
  const outcome = acquireControlPlaneOwnership({
    baseDir: runtimeDir,
    instanceId: input.instanceId ?? newInstanceId(),
    ...(input.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: input.busyTimeoutMs }),
  })
  if (outcome.ok) return outcome.lease

  // Perdeu a disputa. A descoberta e consultada AGORA e so para a mensagem: ela nao decidiu
  // nada e nao poderia — se estiver velha ou ausente, a recusa continua valendo.
  const owner = await readControlPlaneFile(runtimeDir).catch(() => undefined)
  throw new ControlPlaneBusyError({
    lockPath: outcome.lockPath,
    ownedDir: outcome.ownedDir,
    owner,
    detail: outcome.detail,
  })
}

export interface ShutdownSteps {
  /** Para de aceitar comando novo e retira o endereco do mapa. */
  stopServing(): Promise<void>
  /** Abandona orquestradores e fecha o banco: e aqui que os EFEITOS param. */
  stopEffects(): Promise<void>
  /** Devolve o projeto. Depois disto, outro processo pode assumir. */
  releaseOwnership(): void
}

/**
 * A ordem do encerramento, isolada porque ela E a garantia — e porque so da para provar uma
 * ordem que tem nome.
 *
 * Tres regras, cada uma com um modo de falha atras:
 *
 * 1. Parar de atender vem primeiro, mas NAO pode bloquear o resto: um socket que se recusa a
 *    fechar nao e razao para deixar loop despachando agente. A falha e guardada e relancada
 *    no fim, para nao virar silencio.
 * 2. Se os EFEITOS nao pararem, a posse NAO e devolvida. Entregar o projeto com loop andando
 *    e o dano de D4 voltando por um caminho de falha; um projeto que continua possuido por um
 *    processo defeituoso e o mal menor, porque a posse morre junto com o processo.
 * 3. Soltar a posse e o ultimo ato.
 */
export async function shutdownControlPlane(steps: ShutdownSteps): Promise<void> {
  const falhaAoParar = await steps.stopServing().then(
    () => undefined,
    (error: unknown) => error,
  )
  await steps.stopEffects()
  steps.releaseOwnership()
  if (falhaAoParar !== undefined) throw falhaAoParar
}
