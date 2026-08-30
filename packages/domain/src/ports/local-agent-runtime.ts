import type { ProviderId } from '../ids.js'
import type { ProviderHealth } from './agent-provider.js'

export interface LocalAgentSpec {
  readonly providerId: ProviderId
  /** Nome ou caminho do binario, vindo de configuracao. O dominio nao conhece o valor (P18). */
  readonly executable: string
  readonly args: readonly string[]
  readonly versionArgs?: readonly string[]
  readonly readinessArgs?: readonly string[]
}

export interface SpawnOptions {
  /** I11: SEMPRE a worktree da tentativa. */
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly stdin?: string
}

export interface ExitStatus {
  readonly code: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly durationMs: number
}

export interface LocalAgentProcess {
  readonly handle: string
  readonly pid: number | null
  readonly cwd: string
  readonly startedAt: Date
  readonly stdout: AsyncIterable<string>
  readonly stderr: AsyncIterable<string>
  exit(): Promise<ExitStatus>
  cancel(reason: string): Promise<void>
}

/**
 * Ciclo de vida de processo local de agente. Nao conhece Mission, Task, Attempt nem estado
 * de run: e a fronteira que sustenta o subscription-first (P17).
 */
export interface LocalAgentRuntime {
  probe(spec: LocalAgentSpec): Promise<ProviderHealth>
  spawn(spec: LocalAgentSpec, opts: SpawnOptions): Promise<LocalAgentProcess>
}
