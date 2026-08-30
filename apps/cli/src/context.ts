import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { CompileInput } from '@agentic/orchestrator'
import type { GatesFile, ProjectFile, SchemaIssue } from '@agentic/schemas'
import { parseGatesFile, parseProjectFile } from '@agentic/schemas'
import type { CommandDeps } from './deps.js'
import { CliError } from './result.js'

export const AGENTIC_DIR = '.agentic'
export const PROJECT_FILE = 'project.yaml'
export const GATES_FILE = 'gates.yaml'
export const MISSIONS_DIR = 'missions'

export interface ProjectContext {
  /** Diretorio que contem `.agentic/`. */
  readonly dir: string
  readonly baseDir: string
  readonly repoRoot: string
  readonly projectPath: string
  readonly gatesPath: string
  readonly projectText: string
  readonly gatesText: string
  readonly project: ProjectFile
  readonly gatesFile: GatesFile
}

export function describeIssues(issues: readonly SchemaIssue[]): string[] {
  return issues.map((issue) => {
    const where =
      issue.line === undefined ? '' : ` (linha ${issue.line}, coluna ${issue.column ?? 1})`
    const path = issue.path.length === 0 ? '(raiz)' : issue.path
    return `  ${path}: ${issue.message}${where}`
  })
}

async function readText(path: string, code: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    throw new CliError(code, `arquivo nao encontrado: ${path}`)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8')
    return true
  } catch {
    return false
  }
}

/** Procura `.agentic/project.yaml` a partir do diretorio dado, subindo ate a raiz. */
export async function findProjectDir(start: string): Promise<string | undefined> {
  let current = resolve(start)
  for (;;) {
    if (await exists(join(current, AGENTIC_DIR, PROJECT_FILE))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export interface ProjectOptions {
  readonly project?: string
}

/**
 * Carrega `project.yaml` + `gates.yaml` ja validados. Arquivo invalido nao vira excecao
 * anonima: vira mensagem com caminho, linha e coluna.
 */
export async function loadProjectContext(
  deps: CommandDeps,
  options: ProjectOptions = {},
): Promise<ProjectContext> {
  const start = options.project === undefined ? deps.cwd : resolve(deps.cwd, options.project)
  const dir = await findProjectDir(start)
  if (dir === undefined) {
    throw new CliError(
      'PROJECT_NOT_FOUND',
      `nenhum ${AGENTIC_DIR}/${PROJECT_FILE} em ${start} nem nos diretorios acima; rode \`agentic init\``,
    )
  }
  const projectPath = join(dir, AGENTIC_DIR, PROJECT_FILE)
  const projectText = await readText(projectPath, 'PROJECT_NOT_FOUND')
  const parsedProject = parseProjectFile(projectText)
  if (!parsedProject.ok) {
    throw new CliError(
      'PROJECT_INVALID',
      [`${projectPath} invalido:`, ...describeIssues(parsedProject.issues)].join('\n'),
    )
  }
  const repoRoot = resolve(dir, parsedProject.value.project.repoRoot)
  const declared = parsedProject.value.gates.file
  const gatesPath = isAbsolute(declared) ? declared : resolve(dir, declared)
  const gatesText = await readText(gatesPath, 'GATES_NOT_FOUND')
  const parsedGates = parseGatesFile(gatesText)
  if (!parsedGates.ok) {
    throw new CliError(
      'GATES_INVALID',
      [`${gatesPath} invalido:`, ...describeIssues(parsedGates.issues)].join('\n'),
    )
  }
  return {
    dir,
    baseDir: join(dir, AGENTIC_DIR),
    repoRoot,
    projectPath,
    gatesPath,
    projectText,
    gatesText,
    project: parsedProject.value,
    gatesFile: parsedGates.value,
  }
}

export interface MissionSource {
  readonly path: string
  readonly text: string
}

export async function readMissionFile(deps: CommandDeps, file: string): Promise<MissionSource> {
  const path = resolve(deps.cwd, file)
  return { path, text: await readText(path, 'MISSION_NOT_FOUND') }
}

export function compileInputOf(context: ProjectContext, mission: MissionSource): CompileInput {
  return {
    missionText: mission.text,
    projectFile: context.projectText,
    gatesFile: context.gatesText,
  }
}
