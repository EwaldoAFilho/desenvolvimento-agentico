import {
  acquireControlPlaneOwnership,
  type ControlPlaneLease,
  newInstanceId,
} from '@agentic/persistence'
import {
  type ControlPlaneRuntime,
  readControlPlaneFile,
  runtimeDirOf,
} from './control-plane-file.js'

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
  readonly repoRoot: string
  /** Injetavel para o teste; por padrao um identificador novo por processo. */
  readonly instanceId?: string
  readonly busyTimeoutMs?: number
}

/**
 * Posse do projeto ou recusa com o dono vivo no motivo.
 *
 * A chave e `<repoRoot>/.agentic` — o diretorio que guarda o `state.db`, canonicalizado. Nao
 * e a porta: `--port` nao compra posse, e dois enderecos diferentes sobre o mesmo projeto
 * continuam sendo dois donos do mesmo banco (D4).
 */
export async function claimControlPlane(input: OwnershipStepInput): Promise<ControlPlaneLease> {
  const runtimeDir = runtimeDirOf(input.repoRoot)
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
