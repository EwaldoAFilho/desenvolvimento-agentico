import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { AGENTIC_DIR, GATES_FILE, MISSIONS_DIR, PROJECT_FILE } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { createOutput } from '../output.js'
import { type CommandResult, ok } from '../result.js'
import {
  EXAMPLE_MISSION_ID,
  GATES_TEMPLATE,
  MISSION_TEMPLATE,
  PROJECT_TEMPLATE,
} from '../templates.js'

export interface InitArgs {
  readonly dir?: string
  readonly json?: boolean
}

export interface InitData {
  readonly baseDir: string
  readonly created: readonly string[]
  readonly skipped: readonly string[]
}

/** `wx` falha se o arquivo existe: nunca sobrescrevemos trabalho humano. */
async function writeIfAbsent(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    const code = (error as { readonly code?: string }).code
    if (code === 'EEXIST') return false
    throw error
  }
}

/**
 * `agentic init`: cria `.agentic/` com projeto, gates e uma missao de exemplo. Idempotente
 * por construcao — o que ja existe e listado como preservado.
 */
export async function initCommand(args: InitArgs, deps: CommandDeps): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const root = resolve(deps.cwd, args.dir ?? '.')
  const baseDir = join(root, AGENTIC_DIR)
  await mkdir(join(baseDir, MISSIONS_DIR), { recursive: true })

  const files: readonly (readonly [string, string])[] = [
    [join(baseDir, PROJECT_FILE), PROJECT_TEMPLATE],
    [join(baseDir, GATES_FILE), GATES_TEMPLATE],
    [join(baseDir, MISSIONS_DIR, `${EXAMPLE_MISSION_ID}.mission.yaml`), MISSION_TEMPLATE],
  ]

  const created: string[] = []
  const skipped: string[] = []
  for (const [path, content] of files) {
    const wrote = await writeIfAbsent(path, content)
    ;(wrote ? created : skipped).push(relative(root, path))
  }

  out.line(`projeto agentico em ${baseDir}`)
  out.line()
  for (const path of created) out.line(`  criado      ${path}`)
  for (const path of skipped) out.line(`  preservado  ${path}`)
  out.line()
  out.line(
    'proximo passo: agentic mission validate ' +
      join(AGENTIC_DIR, MISSIONS_DIR, `${EXAMPLE_MISSION_ID}.mission.yaml`),
  )

  const data: InitData = { baseDir, created, skipped }
  return ok('init', data)
}
