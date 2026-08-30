import type { LocalCliDescriptor, LocalCliProviderOptions } from './local-cli.js'
import { LocalCliAgentProvider } from './local-cli.js'

export const CODEX_PROVIDER_ID = 'codex'
export const CODEX_DEFAULT_COMMAND = 'codex'
/**
 * `exec` e o modo nao interativo: recebe o assignment como argumento e roda ate o fim.
 *
 * `--sandbox workspace-write` foi acrescentado depois que uma sonda com a CLI REAL mostrou
 * `sandbox: read-only` como DEFAULT do `codex exec` — o agente nao conseguiria gravar na
 * worktree que o produto criou para ele, e o smoke falharia como "nao fez nada".
 *
 * E o MINIMO necessario (item 52): escrita limitada ao workspace, nao
 * `--dangerously-bypass-approvals-and-sandbox`. A fronteira continua sendo a worktree
 * (ADR-0007) e o escopo continua verificado por diff (P04).
 */
export const CODEX_RUN_ARGS: readonly string[] = ['exec', '--sandbox', 'workspace-write']
/** Sai 0 e imprime o estado de login; verificado neste ambiente antes de declarar suporte. */
export const CODEX_READINESS_ARGS: readonly string[] = ['login', 'status']

export const CODEX_DESCRIPTOR: LocalCliDescriptor = {
  id: CODEX_PROVIDER_ID,
  command: CODEX_DEFAULT_COMMAND,
  capabilities: {
    roles: ['executor', 'reviewer'],
    streaming: true,
    cancellation: true,
    readinessProbe: 'supported',
    reportsUsage: false,
  },
  versionArgs: ['--version'],
  readinessArgs: CODEX_READINESS_ARGS,
  runArgs: CODEX_RUN_ARGS,
}

export class CodexCliProvider extends LocalCliAgentProvider {
  constructor(options: LocalCliProviderOptions = {}) {
    super(CODEX_DESCRIPTOR, options)
  }
}
