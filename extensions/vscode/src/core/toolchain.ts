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

/**
 * O driver nativo que o control plane carrega. Versao certa de Node nao basta: um modulo
 * nativo e compilado para UMA ABI, e um `node` mais novo que o usado no `npm install` falha
 * ao carrega-lo. O candidato so vale se carregar o driver do projeto — quando o projeto o
 * tem; sem `node_modules` do projeto (CLI instalada em outro lugar) nao ha o que provar.
 */
export const NATIVE_DRIVER = 'better-sqlite3'

export interface Toolchain {
  readonly node: NodeBinary
  readonly cli: CliLocation
  /** Linha de comando pronta para `spawn`. */
  command(args: readonly string[]): { readonly file: string; readonly args: string[] }
}

export class ToolchainError extends Error {
  readonly code: 'NODE_NOT_FOUND' | 'NODE_TOO_OLD' | 'NODE_ABI_MISMATCH' | 'CLI_NOT_FOUND'

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

/**
 * `ok` = carregou; `fail` = este node nao serve para este projeto; `unknown` = o projeto nao
 * tem o driver instalado, entao nao ha prova a fazer.
 */
export async function probeNativeDriver(
  io: ToolchainIo,
  nodePath: string,
  repoRoot: string,
): Promise<{ readonly result: 'ok' | 'fail' | 'unknown'; readonly detail?: string }> {
  const driver = join(repoRoot, 'node_modules', NATIVE_DRIVER)
  if (!(await io.exists(driver))) return { result: 'unknown' }
  try {
    // `require` do pacote nao basta: o driver carrega o binario nativo de forma preguicosa,
    // na PRIMEIRA abertura de banco. A prova e abrir um banco em memoria.
    const script = `const D = require(${JSON.stringify(driver)}); new D(':memory:').close()`
    const probe = await io.exec(nodePath, ['-e', script], repoRoot)
    if (probe.code === 0) return { result: 'ok' }
    const detail =
      (probe.stderr || probe.stdout).split('\n').find((l) => l.includes('NODE_MODULE_VERSION')) ??
      probe.stderr.trim()
    return { result: 'fail', detail: detail.slice(0, 200) }
  } catch (error) {
    return { result: 'fail', detail: error instanceof Error ? error.message : String(error) }
  }
}

export async function resolveNode(
  io: ToolchainIo,
  settings: ToolchainSettings = {},
  repoRoot?: string,
): Promise<NodeBinary> {
  const tried: string[] = []
  const candidates: string[] = []
  if (settings.nodePath !== undefined && settings.nodePath.trim().length > 0) {
    candidates.push(settings.nodePath.trim())
  }
  candidates.push('node')
  candidates.push(...(await nvmCandidates(io)))
  let tooOld: NodeBinary | undefined
  let mismatched: { readonly node: NodeBinary; readonly detail?: string } | undefined
  for (const candidate of candidates) {
    const version = await versionOf(io, candidate)
    if (version === undefined) {
      tried.push(`${candidate} (nao encontrado)`)
      continue
    }
    const major = majorOf(version)
    if (major === undefined || major < MIN_NODE_MAJOR) {
      tried.push(`${candidate} (${version})`)
      tooOld ??= { path: candidate, version }
      continue
    }
    if (repoRoot !== undefined) {
      const probe = await probeNativeDriver(io, candidate, repoRoot)
      if (probe.result === 'fail') {
        tried.push(`${candidate} (${version}: nao carrega ${NATIVE_DRIVER} do projeto)`)
        mismatched ??= {
          node: { path: candidate, version },
          ...(probe.detail === undefined ? {} : { detail: probe.detail }),
        }
        continue
      }
    }
    return { path: candidate, version }
  }
  if (mismatched !== undefined) {
    throw new ToolchainError(
      'NODE_ABI_MISMATCH',
      `nenhum node carrega o driver nativo do projeto (${NATIVE_DRIVER}); ${mismatched.node.path} (${mismatched.node.version}) ` +
        `falhou${mismatched.detail === undefined ? '' : `: ${mismatched.detail}`}. ` +
        'Use o mesmo node com que rodou `npm install` (ex.: `nvm use 22`, ou aponte-o em `agentic.nodePath`) ' +
        `ou recompile o driver com esse node (\`npm rebuild ${NATIVE_DRIVER}\`). Tentei: ${tried.join(', ')}.`,
    )
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
  const node = await resolveNode(io, settings, repoRoot)
  return {
    node,
    cli,
    command: (args) =>
      cli.kind === 'script'
        ? { file: node.path, args: [cli.path, ...args] }
        : { file: cli.path, args: [...args] },
  }
}

/**
 * Ambiente do filho: uma ALLOWLIST operacional, nunca `process.env` inteiro (P17).
 *
 * O extension host herda o ambiente da sessao do usuario — e ali pode haver token de nuvem,
 * chave de API, credencial de CI. Nada disso e injetado no control plane: passa so o que um
 * processo precisa para achar executaveis, o diretorio do usuario, locale, proxy e certificados.
 */
export const CHILD_ENV_ALLOW: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'NVM_DIR',
  'NODE_ENV',
  'CI',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  // Windows
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'PROGRAMFILES',
]

/** `PATH` do filho com o diretorio do `node` escolhido na frente: shims `#!/usr/bin/env node` acham o mesmo Node. */
export function childEnv(
  env: Readonly<Record<string, string | undefined>>,
  node: NodeBinary,
): Record<string, string | undefined> {
  const allowed = new Set(CHILD_ENV_ALLOW)
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && allowed.has(key)) out[key] = value
  }
  if (node.path === 'node') return out
  const dir = dirname(node.path)
  const current = out.PATH ?? ''
  return { ...out, PATH: current.length === 0 ? dir : `${dir}:${current}` }
}
