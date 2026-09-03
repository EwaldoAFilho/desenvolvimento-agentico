import { AGENTIC_DIR } from './context.js'

/**
 * O que o `agentic init` precisa manter FORA do Git, e por que cada linha existe.
 *
 * Nao e higiene: sem estas exclusoes o observador do repositorio hasheia `state.db-wal` e
 * `-shm` a cada tick, a impressao digital do projeto muda no meio do planejamento e o
 * planejador e recusado com "o repositorio mudou durante o planejamento". A worktree
 * aninhada e pior: `git hash-object` sai diferente de zero e a digital vira indefinida.
 *
 * O que NAO entra aqui, de proposito: `project.yaml`, `gates.yaml` e `missions/` sao o
 * contrato versionado do projeto (MISSION-FORMAT 1) — ignorar `.agentic/` inteiro
 * esconderia justamente o que a equipe precisa revisar.
 */
export const GITIGNORE_BLOCK: readonly string[] = [
  '# Agentic — estado local do control plane (nunca versionado)',
  `${AGENTIC_DIR}/state.db`,
  `${AGENTIC_DIR}/state.db-*`,
  `${AGENTIC_DIR}/runs/`,
  `${AGENTIC_DIR}/worktrees/`,
  '# Descoberta e posse: valem enquanto um processo vive NESTA maquina',
  `${AGENTIC_DIR}/control-plane.json`,
  `${AGENTIC_DIR}/control-plane.lock.db`,
  `${AGENTIC_DIR}/control-plane.lock.db-*`,
]

/** Linhas do bloco que sao padrao de fato — comentario nao conta como entrada. */
export const GITIGNORE_PATTERNS: readonly string[] = GITIGNORE_BLOCK.filter(
  (line) => !line.startsWith('#'),
)

export interface GitignoreMerge {
  /** Conteudo final. Igual ao original quando nada faltava. */
  readonly text: string
  /** Padroes efetivamente acrescentados, na ordem em que entraram. */
  readonly added: readonly string[]
}

/**
 * Um padrao ja coberto nao e reescrito. A comparacao e por linha exata (sem espaco em
 * volta): `.agentic/state.db-*` cobre `-wal` e `-shm`, mas quem ja escreveu as duas linhas
 * explicitas tambem esta coberto, e reabrir a discussao seria poluir o arquivo do humano.
 */
function coveredBy(existing: ReadonlySet<string>, pattern: string): boolean {
  if (existing.has(pattern)) return true
  if (!pattern.endsWith('-*')) return false
  const base = pattern.slice(0, -2)
  // `state.db-*` ja esta coberto se o humano listou `state.db-wal` E `state.db-shm`.
  return existing.has(`${base}-wal`) && existing.has(`${base}-shm`)
}

/**
 * Acrescenta ao `.gitignore` SO o que falta, no fim, num bloco proprio.
 *
 * Nunca reescreve, reordena nem remove nada: o arquivo e do humano. Idempotente por
 * construcao — a segunda chamada nao encontra padrao faltando e devolve o texto intacto.
 */
export function mergeGitignore(current: string | undefined): GitignoreMerge {
  const text = current ?? ''
  const existing = new Set(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  )
  const missing = GITIGNORE_PATTERNS.filter((pattern) => !coveredBy(existing, pattern))
  if (missing.length === 0) return { text, added: [] }

  // Bloco inteiro (com os comentarios) quando o arquivo nasce agora ou nao tem nada nosso;
  // so as linhas faltantes quando ja existe cobertura parcial — nunca um comentario repetido.
  const partial = missing.length !== GITIGNORE_PATTERNS.length
  const block = partial ? missing : [...GITIGNORE_BLOCK]
  const prefix = text.length === 0 ? [] : text.endsWith('\n') ? [''] : ['', '']
  return { text: `${text}${[...prefix, ...block, ''].join('\n')}`, added: missing }
}
