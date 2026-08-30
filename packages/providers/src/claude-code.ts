import type { LocalCliDescriptor, LocalCliProviderOptions } from './local-cli.js'
import { LocalCliAgentProvider } from './local-cli.js'

export const CLAUDE_CODE_PROVIDER_ID = 'claude-code'
export const CLAUDE_CODE_DEFAULT_COMMAND = 'claude'
/** Modo nao interativo: le o assignment, trabalha na worktree e escreve o relato em stdout. */
/**
 * `--print` e o modo nao interativo.
 *
 * `--permission-mode acceptEdits` foi acrescentado depois que um smoke com a CLI REAL
 * mostrou o agente recusando-se a gravar: "o harness pediu permissao para gravar e ela nao
 * foi concedida, e esta sessao nao e interativa". Os testes usavam CLIs falsas que sempre
 * escreviam, entao o defeito nunca aparecia.
 *
 * E o MINIMO necessario (ADR-0009, item 52): aceita edicao de arquivo e nada alem disso —
 * nao usamos `--dangerously-skip-permissions`. A fronteira de isolamento continua sendo a
 * worktree da tentativa (ADR-0007), e o escopo continua verificado a posteriori por diff
 * (P04): sair de `touches` ainda reprova com SCOPE_VIOLATION.
 */
export const CLAUDE_CODE_RUN_ARGS: readonly string[] = [
  '--print',
  '--output-format',
  'text',
  '--permission-mode',
  'acceptEdits',
]
/** Sai 0 e imprime o estado da sessao; verificado neste ambiente antes de declarar suporte. */
export const CLAUDE_CODE_READINESS_ARGS: readonly string[] = ['auth', 'status']

/**
 * Prontidao observavel (ADR-0010 4): existe comando real que sai 0 quando ha sessao, entao
 * `readinessProbe` e `'supported'`. O que continua valendo: `ready: true` so com sonda que
 * efetivamente saiu 0 — `--version` responder segue provando instalacao, jamais sessao.
 *
 * A saida desta sonda carrega dado pessoal (e-mail, organizacao). O runtime le dela apenas
 * o sinal booleano de sessao; nada da saida entra em `detail`, `readinessSource`, log ou
 * artefato (ARCHITECTURE 9).
 */
export const CLAUDE_CODE_DESCRIPTOR: LocalCliDescriptor = {
  id: CLAUDE_CODE_PROVIDER_ID,
  command: CLAUDE_CODE_DEFAULT_COMMAND,
  capabilities: {
    roles: ['executor', 'reviewer'],
    streaming: true,
    cancellation: true,
    readinessProbe: 'supported',
    reportsUsage: false,
  },
  versionArgs: ['--version'],
  readinessArgs: CLAUDE_CODE_READINESS_ARGS,
  runArgs: CLAUDE_CODE_RUN_ARGS,
}

export class ClaudeCodeCliProvider extends LocalCliAgentProvider {
  constructor(options: LocalCliProviderOptions = {}) {
    super(CLAUDE_CODE_DESCRIPTOR, options)
  }
}
