import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { CompileInput } from '@agentic/orchestrator'
import type { GatesFile, ProjectFile, SchemaIssue } from '@agentic/schemas'
import { parseGatesFile, parseProjectFile } from '@agentic/schemas'
import { configPathOf, projectIdentityOf } from '@agentic/server'
import type { CommandDeps } from './deps.js'
import { CliError } from './result.js'

export const AGENTIC_DIR = '.agentic'
export const PROJECT_FILE = 'project.yaml'
export const GATES_FILE = 'gates.yaml'
export const MISSIONS_DIR = 'missions'

export interface ProjectContext {
  /** Diretorio que contem `.agentic/`, canonicalizado. Ancora da CONFIGURACAO. */
  readonly dir: string
  /** `<dir>/.agentic`: onde moram `project.yaml`, `gates.yaml` e `missions/`. */
  readonly baseDir: string
  /** Repositorio alvo, canonico. E ele que da NOME ao projeto (I14). */
  readonly repoRoot: string
  /**
   * `<repoRoot>/.agentic`: posse, `state.db`, `control-plane.json`, `runs/` e `worktrees/`.
   *
   * Separado de `baseDir` de proposito. Com `project.repoRoot: .` — o caso comum — os dois
   * sao o mesmo diretorio; com `repoRoot` apontando para fora, confundir um com o outro era
   * como `mission start` e `serve` viravam dois donos do mesmo projeto (I14).
   */
  readonly runtimeDir: string
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
  /**
   * A conta da identidade e UMA, e ela nao mora aqui: `projectIdentityOf` e a mesma funcao
   * que `startServer` usa. Enquanto a CLI derivava a sua versao, `agentic mission start` e
   * `agentic serve` disputavam posses diferentes sobre o mesmo projeto (I14).
   */
  const identity = projectIdentityOf({
    projectFile: projectPath,
    declaredRepoRoot: parsedProject.value.project.repoRoot,
  })
  const gatesPath = configPathOf(identity.projectDir, parsedProject.value.gates.file)
  const gatesText = await readText(gatesPath, 'GATES_NOT_FOUND')
  const parsedGates = parseGatesFile(gatesText)
  if (!parsedGates.ok) {
    throw new CliError(
      'GATES_INVALID',
      [`${gatesPath} invalido:`, ...describeIssues(parsedGates.issues)].join('\n'),
    )
  }
  return {
    dir: identity.projectDir,
    baseDir: join(identity.projectDir, AGENTIC_DIR),
    repoRoot: identity.repoRoot,
    runtimeDir: identity.runtimeDir,
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
