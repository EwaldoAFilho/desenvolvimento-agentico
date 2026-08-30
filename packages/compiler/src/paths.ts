import { isPathInScope, type PathScope, pathScopeSegments, tryPathScope } from '@agentic/domain'

const REGEXP_SPECIALS = /[.+^${}()|[\]\\]/g

/**
 * `denyPaths` aceita glob (`*.pem`) porque e configuracao de projeto escrita por humano
 * (DOMAIN-MODEL: "podem conter glob, por isso sao strings cruas"). `*` nao atravessa `/`,
 * e o padrao tambem e comparado com o ultimo segmento — `*.pem` nega qualquer `.pem`.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(REGEXP_SPECIALS, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`)
}

function lastSegment(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? path
}

function matchesDenyPattern(touch: PathScope, pattern: string): boolean {
  const scope = tryPathScope(pattern)
  if (scope !== undefined) return isPathInScope(touch, scope)
  const expression = globToRegExp(pattern)
  const plain = pathScopeSegments(touch).join('/')
  return expression.test(plain) || expression.test(lastSegment(plain))
}

/** Primeiro padrao de `denyPaths` que contem o escopo, ou `undefined`. */
export function deniedBy(touch: PathScope, denyPaths: readonly string[]): string | undefined {
  return denyPaths.find((pattern) => matchesDenyPattern(touch, pattern))
}

/** Diretorio de topo inteiro (`scripts/`) — o caso amplo de DA2005. */
export function isTopLevelDirectory(touch: PathScope): boolean {
  return touch.endsWith('/') && pathScopeSegments(touch).length <= 1
}
