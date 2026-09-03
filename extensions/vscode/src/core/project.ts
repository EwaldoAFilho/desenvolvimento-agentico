import { dirname, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { PROJECT_FILE_NAME, RUNTIME_DIR_NAME } from './contracts.js'

/**
 * Deteccao do projeto a partir de uma pasta aberta no editor.
 *
 * A conta e a mesma da CLI (`findProjectDir` + `projectIdentityOf`): sobe a partir da pasta
 * ate achar `.agentic/project.yaml`; o `repoRoot` declarado ali, resolvido e canonicalizado,
 * e o NOME do projeto (I14). A extensao nao carrega o parser de schemas — le apenas as tres
 * chaves de que precisa, sem validar o resto: validar e trabalho do control plane, e um
 * `project.yaml` invalido aparece como falha do `serve`, com linha e coluna, no log.
 */
export interface ProjectIo {
  /** `undefined` quando o arquivo nao existe ou nao pode ser lido. */
  readFile(path: string): Promise<string | undefined>
  /** Caminho real; devolve o proprio caminho quando ele ainda nao existe. */
  realpath(path: string): Promise<string>
  exec(command: string, args: readonly string[], cwd: string): Promise<ExecResult>
}

export interface ExecResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface DetectedProject {
  readonly name: string
  /** Diretorio que contem `.agentic/` (ancora da configuracao), canonico. */
  readonly projectDir: string
  readonly projectFile: string
  readonly missionsDir: string
  /** Repositorio alvo, canonico: a identidade do projeto. */
  readonly repoRoot: string
  /** `<repoRoot>/.agentic`: onde moram posse, estado e descoberta. */
  readonly runtimeDir: string
  /** Endereco DESEJADO (`server` do project.yaml); onde um processo esta AGORA e outra pergunta. */
  readonly declaredUrl: string
  readonly git: GitInfo
}

export interface GitInfo {
  readonly repository: boolean
  readonly root?: string
  readonly branch?: string
  readonly detail?: string
}

interface ProjectYamlFacts {
  readonly name?: string
  readonly repoRoot?: string
  readonly host?: string
  readonly port?: number
}

function section(doc: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof doc !== 'object' || doc === null) return undefined
  const value = (doc as Record<string, unknown>)[key]
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * A MESMA normalizacao do schema compartilhado (`NonEmptyStringSchema = z.string().trim().min(1)`):
 * a CLI apara as strings antes de resolver caminhos, e a extensao precisa derivar a mesma
 * identidade. Vazio depois do trim vale como ausente — o schema recusaria; aqui o `serve`
 * dira linha e coluna.
 */
function stringOf(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Leitura de `project.name`, `project.repoRoot`, `server.host` e `server.port` com um parser
 * YAML generico: flow mappings, escapes e `#` dentro de string sao YAML valido, e a CLI os
 * aceita — a extensao precisa derivar a MESMA identidade (I14). Nada e validado alem
 * disso: validar e trabalho do control plane. YAML invalido vira "sem fatos", e o `serve`
 * dira linha e coluna.
 */
export function readProjectFacts(text: string): ProjectYamlFacts {
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch {
    return {}
  }
  const project = section(doc, 'project')
  const server = section(doc, 'server')
  const rawPort = server?.port
  const port =
    typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort > 0
      ? rawPort
      : typeof rawPort === 'string' && /^\d+$/.test(rawPort)
        ? Number.parseInt(rawPort, 10)
        : undefined
  const name = stringOf(project, 'name')
  const repoRoot = stringOf(project, 'repoRoot')
  const host = stringOf(server, 'host')
  return {
    ...(name === undefined ? {} : { name }),
    ...(repoRoot === undefined ? {} : { repoRoot }),
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
  }
}

/** Sobe a partir de `start` ate achar `<dir>/.agentic/project.yaml`. */
export async function findProjectDir(start: string, io: ProjectIo): Promise<string | undefined> {
  let current = resolve(start)
  for (;;) {
    const text = await io.readFile(join(current, RUNTIME_DIR_NAME, PROJECT_FILE_NAME))
    if (text !== undefined) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function gitInfoOf(dir: string, io: ProjectIo): Promise<GitInfo> {
  let root: ExecResult
  try {
    root = await io.exec('git', ['rev-parse', '--show-toplevel'], dir)
  } catch (error) {
    return { repository: false, detail: `git indisponivel: ${messageOf(error)}` }
  }
  if (root.code !== 0) {
    return { repository: false, detail: root.stderr.trim() || 'nao e um repositorio git' }
  }
  const branch = await io
    .exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir)
    .catch(() => undefined)
  const name = branch?.code === 0 ? branch.stdout.trim() : undefined
  return {
    repository: true,
    root: await io.realpath(root.stdout.trim()),
    ...(name === undefined || name.length === 0 ? {} : { branch: name }),
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function detectProject(
  start: string,
  io: ProjectIo,
): Promise<DetectedProject | undefined> {
  const found = await findProjectDir(start, io)
  if (found === undefined) return undefined
  const projectDir = await io.realpath(found)
  const projectFile = join(projectDir, RUNTIME_DIR_NAME, PROJECT_FILE_NAME)
  const text = (await io.readFile(projectFile)) ?? ''
  const facts = readProjectFacts(text)
  const repoRoot = await io.realpath(resolve(projectDir, facts.repoRoot ?? '.'))
  const host = facts.host ?? '127.0.0.1'
  const port = facts.port ?? 4317
  return {
    name: facts.name ?? projectDir.split(/[\\/]/).at(-1) ?? projectDir,
    projectDir,
    projectFile,
    missionsDir: join(projectDir, RUNTIME_DIR_NAME, 'missions'),
    repoRoot,
    runtimeDir: join(repoRoot, RUNTIME_DIR_NAME),
    declaredUrl: `http://${host}:${port}`,
    git: await gitInfoOf(repoRoot, io),
  }
}
