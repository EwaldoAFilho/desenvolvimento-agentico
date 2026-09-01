import { resolve } from 'node:path'
import { canonicalIfPresent } from '@agentic/persistence'
import { type ControlPlaneRuntime, discoverControlPlane } from '@agentic/server'
import type { ProjectContext } from './context.js'
import { endpointOf } from './link.js'

/**
 * De onde saiu o endereco que a CLI vai tentar.
 *
 * `project.yaml` diz onde o control plane DEVERIA estar; `control-plane.json` diz onde um
 * processo esta AGORA — e com qual pid. Sem isso, um `serve` em porta diferente da declarada
 * some do mapa e `mission pause` fala com o vazio.
 */
export type EndpointSource = 'flag' | 'runtime' | 'project'

export interface ResolvedEndpoint {
  readonly endpoint: string
  readonly source: EndpointSource
  readonly pid?: number
}

/**
 * Onde o registro de descoberta mora: UM diretorio, o mesmo que a posse protege.
 *
 * Antes eram dois candidatos, e a lista existia justamente porque `mission start` e `serve`
 * gravavam em lugares diferentes quando `project.repoRoot` apontava para fora. Com a
 * identidade unificada (I14) o segundo candidato deixou de existir — e procurar em dois
 * lugares voltaria a mascarar a divergencia se ela reaparecesse.
 */
export function runtimeDirsOf(context: ProjectContext): string[] {
  return [resolve(context.runtimeDir)]
}

export interface DiscoveryOptions {
  readonly port?: number
  readonly alive?: (pid: number) => boolean
}

/**
 * O registro de um processo VIVO — e do NOSSO projeto.
 *
 * A checagem de `repoRoot` nao e zelo: um registro velho, um `.agentic` copiado junto com o
 * diretorio, ou um caminho reaproveitado fazem a descoberta apontar para o control plane de
 * OUTRO projeto. Mandar um comando de mutacao para la seria escrever no run errado. Registro
 * antigo, sem `repoRoot`, nao e descartado: nao ha o que conferir, e a confirmacao forte
 * acontece no `/api/health` antes de qualquer comando (ver `connectHttp`).
 */
export async function discoverRuntime(
  context: ProjectContext,
  options: DiscoveryOptions = {},
): Promise<ControlPlaneRuntime | undefined> {
  for (const dir of runtimeDirsOf(context)) {
    const runtime = await discoverControlPlane(dir, {
      ...(options.alive === undefined ? {} : { alive: options.alive }),
    })
    if (runtime === undefined) continue
    if (!sameProject(context, runtime.repoRoot)) continue
    return runtime
  }
  return undefined
}

/**
 * O endereco pertence a ESTE projeto?
 *
 * Comparacao por caminho REAL: o control plane responde com o caminho que ele possui, e
 * `/repo` e `/atalho-para-repo` sao o mesmo projeto. Um caminho que nao existe mais nao
 * confere com nada — e nao conferir e a resposta certa.
 */
export function sameProject(context: ProjectContext, repoRoot: string | undefined): boolean {
  if (repoRoot === undefined) return true
  return canonicalIfPresent(repoRoot) === context.repoRoot
}

/**
 * Endereco efetivo do control plane. Precedencia: `--port` explicito, depois o registro de
 * runtime com processo vivo, depois o endereco declarado no `project.yaml`.
 *
 * Registro apontando para processo morto e limpo por `discoverControlPlane` e nao decide
 * nada — vale como "nao ha control plane".
 */
export async function resolveEndpoint(
  context: ProjectContext,
  options: DiscoveryOptions = {},
): Promise<ResolvedEndpoint> {
  if (options.port !== undefined) {
    return { endpoint: endpointOf(context.project, options.port), source: 'flag' }
  }
  const runtime = await discoverRuntime(context, options)
  if (runtime !== undefined) {
    return { endpoint: runtime.url, source: 'runtime', pid: runtime.pid }
  }
  return { endpoint: endpointOf(context.project), source: 'project' }
}

export function describeEndpoint(resolved: ResolvedEndpoint): string {
  if (resolved.source === 'flag') return `${resolved.endpoint} (--port)`
  if (resolved.source === 'runtime') {
    return `${resolved.endpoint} (.agentic/control-plane.json, pid ${resolved.pid})`
  }
  return `${resolved.endpoint} (server do project.yaml)`
}
