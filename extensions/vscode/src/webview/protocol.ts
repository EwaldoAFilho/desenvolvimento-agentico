/**
 * Validadores compartilhados pela ponte da webview e pelos comandos: refs e caminhos que
 * NUNCA viram opcao do git nem saem do repositorio por `..`.
 */
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Ref de git que NUNCA vira opcao: sem `-` inicial, sem espaco, sem `..`/`:`; nomes e hashes so. */
export const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export function isGitRef(value: unknown): value is string {
  return (
    nonEmpty(value) && GIT_REF_PATTERN.test(value) && !value.includes('..') && !value.endsWith('/')
  )
}

/** Caminho de arquivo que nunca vira opcao do git nem sai por `..`. */
export function isRepoPath(value: unknown): value is string {
  return nonEmpty(value) && !value.startsWith('-') && !value.split(/[\\/]/).includes('..')
}
