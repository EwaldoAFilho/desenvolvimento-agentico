import type { LocalCliDescriptor, LocalCliProviderOptions } from './local-cli.js'
import { LocalCliAgentProvider } from './local-cli.js'

export const CLAUDE_CODE_PROVIDER_ID = 'claude-code'
export const CLAUDE_CODE_DEFAULT_COMMAND = 'claude'
/** Modo nao interativo: le o assignment, trabalha na worktree e escreve o relato em stdout. */
export const CLAUDE_CODE_RUN_ARGS: readonly string[] = ['--print', '--output-format', 'text']

/**
 * Regra dura (ADR-0010): nao existe comando documentado e confiavel para observar a
 * autenticacao desta CLI. `--version` responder prova instalacao, jamais sessao valida.
 * Declaramos `readinessProbe: 'unsupported'`, nao ha `readinessArgs`, e `ready` cai em
 * 'unknown'. Inventar uma sonda aqui seria mentir para o operador.
 */
export const CLAUDE_CODE_DESCRIPTOR: LocalCliDescriptor = {
  id: CLAUDE_CODE_PROVIDER_ID,
  command: CLAUDE_CODE_DEFAULT_COMMAND,
  capabilities: {
    roles: ['executor', 'reviewer'],
    streaming: true,
    cancellation: true,
    readinessProbe: 'unsupported',
    reportsUsage: false,
  },
  versionArgs: ['--version'],
  runArgs: CLAUDE_CODE_RUN_ARGS,
}

export class ClaudeCodeCliProvider extends LocalCliAgentProvider {
  constructor(options: LocalCliProviderOptions = {}) {
    super(CLAUDE_CODE_DESCRIPTOR, options)
  }
}
