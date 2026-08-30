import type { LocalCliDescriptor, LocalCliProviderOptions } from './local-cli.js'
import { LocalCliAgentProvider } from './local-cli.js'

export const CODEX_PROVIDER_ID = 'codex'
export const CODEX_DEFAULT_COMMAND = 'codex'
/** `exec` e o modo nao interativo: recebe o assignment como argumento e roda ate o fim. */
export const CODEX_RUN_ARGS: readonly string[] = ['exec']
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
