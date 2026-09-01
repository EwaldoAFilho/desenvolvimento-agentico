import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import nodeProcess from 'node:process'
import { fileURLToPath } from 'node:url'
import type { GatesFile, ProjectFile } from '@agentic/schemas'
import { parseGatesFile, parseProjectFile, type SchemaIssue } from '@agentic/schemas'
import { configPathOf, projectIdentityOf } from './project-identity.js'

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
  /**
   * NAO existe opcao de diretorio de estado.
   *
   * Ela existiu enquanto `runtimeDir` era so o lugar do `control-plane.json`. Depois que ele
   * passou a ser tambem a CHAVE DE POSSE, aceitar um valor do chamador era abrir de volta o
   * bypass que 003B veio fechar: duas chamadas de `startServer` para o mesmo `repoRoot`, com
   * diretorios diferentes, disputariam locks diferentes e venceriam as duas (I14). O estado
   * mora onde `projectIdentityOf` diz, e ponto.
   */
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
  /** Repositorio alvo, canonico — ja com `project.repoRoot` aplicado (I14). */
  readonly repoRoot: string
  /** Diretorio que ancora a configuracao: o que contem `.agentic/project.yaml`. */
  readonly projectDir: string
  /** `<repoRoot>/.agentic`: posse, `state.db`, descoberta, runs e worktrees. */
  readonly runtimeDir: string
  readonly projectPath: string
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
  // `config.repoRoot` diz apenas ONDE PROCURAR o `project.yaml`. Quem manda na identidade do
  // projeto e o arquivo: `project.repoRoot` pode apontar para fora, e ignora-lo aqui era
  // exatamente como `serve` e `mission start` chegavam a duas chaves de posse diferentes.
  const searchRoot = resolve(config.repoRoot ?? nodeProcess.cwd())
  const projectPath = resolve(searchRoot, config.projectFile ?? DEFAULT_PROJECT_FILE)
  const projectText = await readText(projectPath, 'PROJECT_FILE_MISSING')
  const project = parseProjectFile(projectText)
  if (!project.ok) {
    throw new ServerConfigError('PROJECT_FILE_INVALID', `${projectPath} invalido`, project.issues)
  }
  const identity = projectIdentityOf({
    projectFile: projectPath,
    declaredRepoRoot: project.value.project.repoRoot,
  })
  // Caminho de CONFIGURACAO: ancora no diretorio do `project.yaml`, nunca no repositorio.
  const gatesPath = configPathOf(identity.projectDir, project.value.gates.file)
  const gatesText = await readText(gatesPath, 'GATES_FILE_MISSING')
  const gates = parseGatesFile(gatesText)
  if (!gates.ok) {
    throw new ServerConfigError('GATES_FILE_INVALID', `${gatesPath} invalido`, gates.issues)
  }
  return {
    repoRoot: identity.repoRoot,
    projectDir: identity.projectDir,
    runtimeDir: identity.runtimeDir,
    projectPath,
    project: project.value,
    projectText,
    gatesFile: gates.value,
    gatesText,
  }
}
