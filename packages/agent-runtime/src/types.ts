import type { ProviderCapabilities } from '@agentic/domain'
import type { RuntimeDeps } from '@agentic/process'
import type { CapacityLedger } from './capacity.js'

/**
 * O que o chamador sabe e o runtime nao: capacidades declaradas do provider e a
 * contabilidade de vagas. O runtime aceita e repassa — nao infere nenhum dos dois.
 */
export interface ProbeContext {
  readonly capabilities?: ProviderCapabilities
  readonly running?: number
  readonly capacity?: number | null
}

export interface LocalAgentRuntimeDeps {
  readonly now?: () => number
  readonly platform?: NodeJS.Platform
  /** PATH usado apenas para LOCALIZAR o binario; nunca entra no ambiente do filho (P17). */
  readonly pathEnv?: string | undefined
  readonly pathExt?: string | undefined
  readonly isExecutableFile?: (candidate: string) => Promise<boolean | null>
  readonly isDirectory?: (candidate: string) => Promise<boolean>
  /** Timeout curto do probe: perguntar versao ou prontidao nao pode segurar o control plane. */
  readonly probeTimeoutMs?: number
  readonly probeCwd?: string
  /** Ambiente dos processos de probe. Default: allowlist minima, sem credencial (P17). */
  readonly probeEnv?: Readonly<Record<string, string>>
  readonly probeMaxOutputBytes?: number
  /** Fonte de `running`/`capacity` quando o chamador nao informa no `ProbeContext`. */
  readonly ledger?: CapacityLedger
  /** Injecao do primitivo de processo (spawn, tree-kill, buffers): so testes trocam. */
  readonly processDeps?: RuntimeDeps
}
