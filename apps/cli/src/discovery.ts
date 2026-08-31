import { resolve } from 'node:path'
import { type ControlPlaneRuntime, discoverControlPlane, runtimeDirOf } from '@agentic/server'
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
 * Diretorios onde o registro pode estar. Quase sempre um so; quando `project.repoRoot`
 * aponta para fora, quem publica grava em `<repoRoot>/.agentic` e vale olhar os dois.
 */
export function runtimeDirsOf(context: ProjectContext): string[] {
  const dirs = [resolve(context.baseDir), runtimeDirOf(context.repoRoot)]
  return [...new Set(dirs)]
}

export interface DiscoveryOptions {
  readonly port?: number
  readonly alive?: (pid: number) => boolean
}

/** Primeiro registro de processo VIVO entre os diretorios candidatos. */
export async function discoverRuntime(
  context: ProjectContext,
  options: DiscoveryOptions = {},
): Promise<ControlPlaneRuntime | undefined> {
  for (const dir of runtimeDirsOf(context)) {
    const runtime = await discoverControlPlane(dir, {
      ...(options.alive === undefined ? {} : { alive: options.alive }),
    })
    if (runtime !== undefined) return runtime
  }
  return undefined
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
