import nodeProcess from 'node:process'

/**
 * Allowlist estrita: so as chaves listadas atravessam. Nunca copiamos o ambiente
 * inteiro — segredo do shell do usuario nao vaza para o processo filho (ADR-0012,
 * ARCHITECTURE secao 9).
 */
export function buildEnv(
  allow: readonly string[],
  source: NodeJS.ProcessEnv = nodeProcess.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of allow) {
    const value = source[key]
    if (typeof value === 'string') out[key] = value
  }
  return out
}
