import { dirname, join } from 'node:path'
import type { ExecResult } from './project.js'

/**
 * Onde estao `node` e a CLI `agentic` que sobem o control plane.
 *
 * O extension host roda no Node do editor, que nao e o Node do projeto: o driver SQLite e
 * um modulo nativo compilado para o Node do usuario (>= 22), entao o control plane precisa
 * nascer num `node` de verdade. A ordem e: configuracao explicita, `PATH`, instalacoes do
 * nvm. A CLI: configuracao, o proprio repositorio (dogfooding do monorepo), `node_modules`
 * do projeto, `PATH`.
 */
export const MIN_NODE_MAJOR = 22

export interface ToolchainIo {
  exists(path: string): Promise<boolean>
  readdir(path: string): Promise<string[]>
  realpath(path: string): Promise<string>
  exec(command: string, args: readonly string[], cwd: string): Promise<ExecResult>
  readonly env: Readonly<Record<string, string | undefined>>
  readonly homedir: string
  readonly platform: string
}

export interface NodeBinary {
  readonly path: string
  readonly version: string
}

export interface CliLocation {
  /** `script` = arquivo `.mjs`/`.js` executado pelo `node` resolvido; `binary` = executavel proprio. */
  readonly kind: 'script' | 'binary'
  readonly path: string
  readonly source: 'setting' | 'repo' | 'node_modules' | 'path'
}

export interface ToolchainSettings {
  readonly nodePath?: string
  readonly cliPath?: string
}

export interface Toolchain {
  readonly node: NodeBinary
  readonly cli: CliLocation
  /** Linha de comando pronta para `spawn`. */
  command(args: readonly string[]): { readonly file: string; readonly args: string[] }
}

export class ToolchainError extends Error {
  readonly code: 'NODE_NOT_FOUND' | 'NODE_TOO_OLD' | 'CLI_NOT_FOUND'

  constructor(code: ToolchainError['code'], message: string) {
    super(message)
    this.name = 'ToolchainError'
    this.code = code
  }
}

export function majorOf(version: string): number | undefined {
  const match = /^v?(\d+)\./.exec(version.trim())
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10)
}

async function versionOf(io: ToolchainIo, path: string): Promise<string | undefined> {
  try {
    const result = await io.exec(path, ['--version'], io.homedir)
    if (result.code !== 0) return undefined
    const version = result.stdout.trim()
    return version.length === 0 ? undefined : version
  } catch {
    return undefined
  }
}

function executableName(io: ToolchainIo, name: string): string {
  return io.platform === 'win32' ? `${name}.exe` : name
}

/** Candidatos do nvm, do mais novo para o mais velho. */
async function nvmCandidates(io: ToolchainIo): Promise<string[]> {
  const root = io.env.NVM_DIR ?? join(io.homedir, '.nvm')
  const versions = join(root, 'versions', 'node')
  if (!(await io.exists(versions))) return []
  const entries = await io.readdir(versions).catch(() => [] as string[])
  return entries
    .filter((entry) => /^v\d+\.\d+\.\d+$/.test(entry))
    .sort((a, b) => compareVersions(b, a))
    .map((entry) => join(versions, entry, 'bin', executableName(io, 'node')))
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export async function resolveNode(
  io: ToolchainIo,
  settings: ToolchainSettings = {},
): Promise<NodeBinary> {
  const tried: string[] = []
  const candidates: string[] = []
  if (settings.nodePath !== undefined && settings.nodePath.trim().length > 0) {
    candidates.push(settings.nodePath.trim())
  }
  candidates.push('node')
  candidates.push(...(await nvmCandidates(io)))
  let tooOld: NodeBinary | undefined
  for (const candidate of candidates) {
    const version = await versionOf(io, candidate)
    if (version === undefined) {
      tried.push(`${candidate} (nao encontrado)`)
      continue
    }
    const major = majorOf(version)
    if (major !== undefined && major >= MIN_NODE_MAJOR) return { path: candidate, version }
    tried.push(`${candidate} (${version})`)
    tooOld ??= { path: candidate, version }
  }
  if (tooOld !== undefined) {
    throw new ToolchainError(
      'NODE_TOO_OLD',
      `o control plane exige node >= ${MIN_NODE_MAJOR}; encontrado ${tooOld.version} em ${tooOld.path}. ` +
        'Aponte um node mais novo em `agentic.nodePath`.',
    )
  }
  throw new ToolchainError(
    'NODE_NOT_FOUND',
    `nenhum node >= ${MIN_NODE_MAJOR} encontrado (tentei: ${tried.join(', ') || 'nada'}). ` +
      'Aponte o executavel em `agentic.nodePath`.',
  )
}

async function whichOnPath(io: ToolchainIo, name: string): Promise<string | undefined> {
  const path = io.env.PATH ?? ''
  const sep = io.platform === 'win32' ? ';' : ':'
  for (const dir of path.split(sep)) {
    if (dir.length === 0) continue
    const full = join(dir, name)
    if (await io.exists(full)) return full
  }
  return undefined
}

function isScript(path: string): boolean {
  return /\.(m?js|cjs)$/i.test(path)
}

export async function resolveCli(
  io: ToolchainIo,
  repoRoot: string,
  settings: ToolchainSettings = {},
): Promise<CliLocation> {
  const configured = settings.cliPath?.trim()
  if (configured !== undefined && configured.length > 0) {
    if (!(await io.exists(configured))) {
      throw new ToolchainError(
        'CLI_NOT_FOUND',
        `agentic.cliPath aponta para ${configured}, que nao existe`,
      )
    }
    const real = await io.realpath(configured)
    return { kind: isScript(real) ? 'script' : 'binary', path: real, source: 'setting' }
  }
  const inRepo = join(repoRoot, 'apps', 'cli', 'bin', 'agentic.mjs')
  if (await io.exists(inRepo)) return { kind: 'script', path: inRepo, source: 'repo' }
  const inModules = join(repoRoot, 'node_modules', '.bin', 'agentic')
  if (await io.exists(inModules)) {
    const real = await io.realpath(inModules)
    return { kind: isScript(real) ? 'script' : 'binary', path: real, source: 'node_modules' }
  }
  const onPath = await whichOnPath(io, executableName(io, 'agentic'))
  if (onPath !== undefined) {
    const real = await io.realpath(onPath)
    return { kind: isScript(real) ? 'script' : 'binary', path: real, source: 'path' }
  }
  throw new ToolchainError(
    'CLI_NOT_FOUND',
    'CLI `agentic` nao encontrada: nem em apps/cli/bin do repositorio, nem em node_modules/.bin, ' +
      'nem no PATH. Aponte o caminho em `agentic.cliPath`.',
  )
}

export async function resolveToolchain(
  io: ToolchainIo,
  repoRoot: string,
  settings: ToolchainSettings = {},
): Promise<Toolchain> {
  const cli = await resolveCli(io, repoRoot, settings)
  const node = await resolveNode(io, settings)
  return {
    node,
    cli,
    command: (args) =>
      cli.kind === 'script'
        ? { file: node.path, args: [cli.path, ...args] }
        : { file: cli.path, args: [...args] },
  }
}

/** `PATH` do filho com o diretorio do `node` escolhido na frente: shims `#!/usr/bin/env node` acham o mesmo Node. */
export function childEnv(
  env: Readonly<Record<string, string | undefined>>,
  node: NodeBinary,
): Record<string, string | undefined> {
  if (node.path === 'node') return { ...env }
  const dir = dirname(node.path)
  const current = env.PATH ?? ''
  return { ...env, PATH: current.length === 0 ? dir : `${dir}:${current}` }
}
