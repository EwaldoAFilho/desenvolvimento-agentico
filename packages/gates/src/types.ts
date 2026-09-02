import type {
  AttemptId,
  CommandResult,
  Gate,
  GateExecution,
  GateScope,
  RunId,
} from '@agentic/domain'
import type { RuntimeDeps } from '@agentic/process'

/** Saida de um stream, ja redigida e pronta para virar artefato (ARCHITECTURE 9). */
export interface GateCommandOutput {
  /** Texto redigido por `redactSecrets`, truncado no limite de captura. */
  readonly text: string
  readonly truncated: boolean
  /** sha256 do stream INTEGRAL capturado, antes da truncagem e da redacao. */
  readonly digest: string
  /** sha256 do que vira artefato (`text`), para o humano conferir o arquivo salvo. */
  readonly artifactDigest: string
}

export interface GateCommandError {
  readonly code: string
  readonly message: string
}

/**
 * O fato medido de um comando. Estende `CommandResult` do dominio: a linha e exatamente a
 * declarada no arquivo versionado, para colar no terminal (P08).
 */
export interface GateCommandRecord extends CommandResult {
  readonly index: number
  readonly required: boolean
  /** argv efetivo do spawn. Vazio quando o comando foi recusado antes de existir. */
  readonly argv: readonly string[]
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly truncated: boolean
  readonly startedAt: Date
  readonly finishedAt: Date
  readonly stdout: GateCommandOutput
  readonly stderr: GateCommandOutput
  /** Presente quando o processo nao chegou a rodar (recusa ou falha de spawn). */
  readonly error?: GateCommandError
}

/** `FAIL_FAST`: um obrigatorio reprovou antes. `ABORTED`: o chamador cancelou o gate. */
export type GateSkipReason = 'FAIL_FAST' | 'ABORTED'

/** Comando declarado que nao rodou. Existe para o relatorio nao mentir sobre cobertura. */
export interface SkippedGateCommand {
  readonly index: number
  readonly command: string
  readonly cwd: string
  readonly required: boolean
  readonly reason: GateSkipReason
  /**
   * Indice do comando que interrompeu a sequencia: o obrigatorio que reprovou, ou o ultimo
   * que chegou a rodar antes do cancelamento (`-1` quando nenhum rodou).
   */
  readonly after: number
}

export interface GateRunRequest {
  readonly gate: Gate
  readonly scope: GateScope
  /** Workspace da tentativa (ou da integracao, no gate de missao). Absoluto. */
  readonly cwd: string
  readonly runId: RunId
  readonly attemptId?: AttemptId
  /** Allowlist efetiva. Nunca amplia o que o arquivo versionado declarou. */
  readonly envAllow: readonly string[]
  /**
   * Cancelamento cooperativo (encerramento do control plane). O comando em execucao e
   * encerrado como processo — SIGTERM, depois SIGKILL — e os seguintes nao chegam a rodar.
   */
  readonly signal?: AbortSignal
}

export interface GateRunResult extends GateExecution {
  readonly results: readonly GateCommandRecord[]
  readonly skipped: readonly SkippedGateCommand[]
  readonly finishedAt: Date
  /** Workspace resolvido em que o gate rodou. */
  readonly cwd: string
  readonly envAllow: readonly string[]
}

export interface GateRunnerDeps {
  readonly now?: () => number
  readonly newId?: () => string
  /** Origem das variaveis filtradas pela allowlist. Default: o ambiente do processo. */
  readonly envSource?: NodeJS.ProcessEnv
  readonly maxOutputBytes?: number
  readonly defaultTimeoutMs?: number
  readonly processDeps?: RuntimeDeps
}
