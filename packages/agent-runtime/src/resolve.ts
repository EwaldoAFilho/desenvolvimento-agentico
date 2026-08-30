import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import nodeProcess from 'node:process'
import { describeError } from './errors.js'

export interface ExecutableFound {
  readonly status: 'found'
  readonly path: string
}

export interface ExecutableNotFound {
  readonly status: 'not-found'
  readonly detail: string
}

/** Nao foi possivel apurar: reportamos `unknown`, nunca inferimos (ADR-0009/ADR-0010). */
export interface ExecutableUnknown {
  readonly status: 'unknown'
  readonly detail: string
}

export type ExecutableResolution = ExecutableFound | ExecutableNotFound | ExecutableUnknown

export interface ResolveExecutableDeps {
  readonly platform?: NodeJS.Platform
  /** PATH usado apenas para LOCALIZAR o binario; nunca entra no ambiente do filho (P17). */
  readonly pathEnv?: string | undefined
  readonly pathExt?: string | undefined
  readonly isExecutableFile?: (candidate: string) => Promise<boolean | null>
}

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'])
const DENIED_CODES = new Set(['EACCES', 'EPERM', 'EISDIR'])

function errorCode(error: unknown): string | null {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  return null
}

/** `true` = arquivo executavel; `false` = existe mas nao serve; `null` = nao existe. */
export async function isExecutableFile(candidate: string): Promise<boolean | null> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(candidate)
  } catch (error) {
    const code = errorCode(error)
    if (code !== null && MISSING_CODES.has(code)) return null
    if (code !== null && DENIED_CODES.has(code)) return false
    throw error
  }
  if (!info.isFile()) return false
  try {
    await access(candidate, fsConstants.X_OK)
    return true
  } catch (error) {
    const code = errorCode(error)
    if (code !== null && (MISSING_CODES.has(code) || DENIED_CODES.has(code))) return false
    throw error
  }
}

export async function isDirectory(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate)
    return info.isDirectory()
  } catch (error) {
    const code = errorCode(error)
    if (code !== null && MISSING_CODES.has(code)) return false
    throw error
  }
}

function candidatesFor(name: string, deps: ResolveExecutableDeps): string[] | null {
  const platform = deps.platform ?? nodeProcess.platform
  const windows = platform === 'win32'
  const literal = name.includes('/') || (windows && name.includes('\\'))
  if (literal) return [isAbsolute(name) ? name : resolvePath(name)]

  const pathEnv = deps.pathEnv
  if (pathEnv === undefined) return null
  const extensions = windows
    ? ['', ...(deps.pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0)]
    : ['']
  const out: string[] = []
  for (const dir of pathEnv.split(windows ? ';' : ':')) {
    if (dir.length === 0) continue
    for (const ext of extensions) out.push(join(dir, `${name}${ext}`))
  }
  return out
}

/**
 * Descoberta do executavel. Encontrado = caminho absoluto; ausente = `not-found`;
 * falha inesperada da propria checagem = `unknown`. Nao ha terceiro caminho otimista.
 */
export async function resolveExecutable(
  executable: string,
  deps: ResolveExecutableDeps = {},
): Promise<ExecutableResolution> {
  const name = executable.trim()
  if (name.length === 0) return { status: 'not-found', detail: 'executavel vazio na especificacao' }

  const candidates = candidatesFor(name, deps)
  if (candidates === null) {
    return { status: 'unknown', detail: 'PATH ausente: instalacao nao verificavel' }
  }
  if (candidates.length === 0) {
    return { status: 'not-found', detail: `PATH vazio: "${name}" nao pode ser localizado` }
  }

  const inspect = deps.isExecutableFile ?? isExecutableFile
  for (const candidate of candidates) {
    let verdict: boolean | null
    try {
      verdict = await inspect(candidate)
    } catch (error) {
      return {
        status: 'unknown',
        detail: `falha ao inspecionar "${candidate}": ${describeError(error)}`,
      }
    }
    if (verdict === true) return { status: 'found', path: candidate }
  }
  return {
    status: 'not-found',
    detail: `"${name}" nao encontrado (${candidates.length} candidato(s) verificados)`,
  }
}
