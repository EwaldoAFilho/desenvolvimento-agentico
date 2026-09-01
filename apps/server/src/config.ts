import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import nodeProcess from 'node:process'
import { fileURLToPath } from 'node:url'
import type { GatesFile, ProjectFile } from '@agentic/schemas'
import { parseGatesFile, parseProjectFile, type SchemaIssue } from '@agentic/schemas'

/** Sem superficie remota nao ha autenticacao — por isso o default nunca sai do loopback. */
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 4317
export const DEFAULT_PROJECT_FILE = '.agentic/project.yaml'
export const DEFAULT_MISSIONS_DIR = '.agentic/missions'
export const DEFAULT_WEB_DIST = 'apps/web/dist'

/**
 * Onde o dashboard REALMENTE mora: junto da instalacao do produto, nao do projeto que esta
 * sendo orquestrado.
 *
 * Resolver `apps/web/dist` contra o repoRoot do alvo era um defeito de uso diario: quem
 * roda `agentic` no proprio repositorio — o caso normal — nunca via o dashboard, e a
 * mensagem de erro ainda mandava rodar um build que nao resolveria nada. Descoberto ao
 * subir a plataforma para uso real, nao por teste.
 */
export function productWebDist(): string | undefined {
  // .../apps/server/dist/config.js  ou  .../apps/server/src/config.ts
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let up = 0; up < 6; up += 1) {
    const candidate = resolve(dir, 'apps/web/dist')
    if (existsSync(join(candidate, 'index.html'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}
export const DEFAULT_HEARTBEAT_MS = 15_000

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  'localhost',
  '0:0:0:0:0:0:0:1',
])

export class ServerConfigError extends Error {
  readonly code: string
  readonly issues: readonly SchemaIssue[]

  constructor(code: string, message: string, issues: readonly SchemaIssue[] = []) {
    super(message)
    this.name = 'ServerConfigError'
    this.code = code
    this.issues = issues
  }
}

export interface ServerConfig {
  readonly repoRoot?: string
  readonly projectFile?: string
  readonly host?: string
  readonly port?: number
  /** Sair do loopback e decisao explicita, nunca efeito colateral (ARCHITECTURE 9). */
  readonly exposeExternally?: boolean
  readonly missionsDir?: string
  readonly webDist?: string
  readonly heartbeatMs?: number
  readonly logger?: boolean
  readonly databasePath?: string
  /** Onde gravar o `control-plane.json` de descoberta. Default: `<repoRoot>/.agentic`. */
  readonly runtimeDir?: string
  /** `false` desliga a publicacao do registro de descoberta. */
  readonly publishRuntimeFile?: boolean
  /** Identidade deste control plane. Injetavel para o teste; por padrao, uma nova por boot. */
  readonly instanceId?: string
}

export interface BindAddress {
  readonly host: string
  readonly port: number
  readonly exposed: boolean
}

/**
 * Configuracao efetiva de rede. Precedencia: flag da CLI, depois `server` do project.yaml,
 * depois o default de loopback. Host fora do loopback sem `exposeExternally` e recusado.
 */
export function resolveBind(config: ServerConfig = {}, project?: ProjectFile): BindAddress {
  const host = config.host ?? project?.server.host ?? DEFAULT_HOST
  const port = config.port ?? project?.server.port ?? DEFAULT_PORT
  const exposed = !LOOPBACK_HOSTS.has(host)
  if (exposed && config.exposeExternally !== true) {
    throw new ServerConfigError(
      'BIND_NOT_ALLOWED',
      `bind em ${host} expoe o control plane fora do loopback: exige flag explicita`,
    )
  }
  return { host, port, exposed }
}

export interface ProjectSources {
  readonly repoRoot: string
  readonly project: ProjectFile
  readonly projectText: string
  readonly gatesFile: GatesFile
  readonly gatesText: string
}

async function readText(path: string, code: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    throw new ServerConfigError(code, `arquivo nao encontrado: ${path}`)
  }
}

/**
 * Le project.yaml e gates.yaml do disco. O TEXTO tambem fica guardado: compilar uma missao
 * e funcao pura sobre o conteudo dos tres arquivos (ARCHITECTURE 7).
 */
export async function loadProjectSources(config: ServerConfig = {}): Promise<ProjectSources> {
  const repoRoot = resolve(config.repoRoot ?? nodeProcess.cwd())
  const projectPath = resolve(repoRoot, config.projectFile ?? DEFAULT_PROJECT_FILE)
  const projectText = await readText(projectPath, 'PROJECT_FILE_MISSING')
  const project = parseProjectFile(projectText)
  if (!project.ok) {
    throw new ServerConfigError('PROJECT_FILE_INVALID', `${projectPath} invalido`, project.issues)
  }
  const gatesPath = isAbsolute(project.value.gates.file)
    ? project.value.gates.file
    : resolve(repoRoot, project.value.gates.file)
  const gatesText = await readText(gatesPath, 'GATES_FILE_MISSING')
  const gates = parseGatesFile(gatesText)
  if (!gates.ok) {
    throw new ServerConfigError('GATES_FILE_INVALID', `${gatesPath} invalido`, gates.issues)
  }
  return { repoRoot, project: project.value, projectText, gatesFile: gates.value, gatesText }
}
