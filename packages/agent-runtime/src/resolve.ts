import { constants as fsConstants } from 'node:fs'
import { access, lstat, readlink, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import nodeProcess from 'node:process'
import type { ProviderDiagnostic } from '@agentic/domain'
import { describeError } from './errors.js'

export interface ExecutableFound {
  readonly status: 'found'
  readonly path: string
}

export interface ExecutableNotFound {
  readonly status: 'not-found'
  readonly detail: string
  readonly diagnostic?: ProviderDiagnostic
}

/** Nao foi possivel apurar: reportamos `unknown`, nunca inferimos (ADR-0009/ADR-0010). */
export interface ExecutableUnknown {
  readonly status: 'unknown'
  readonly detail: string
  readonly diagnostic?: ProviderDiagnostic
}

export type ExecutableResolution = ExecutableFound | ExecutableNotFound | ExecutableUnknown

export interface ResolveExecutableDeps {
  readonly platform?: NodeJS.Platform
  /** PATH usado apenas para LOCALIZAR o binario; nunca entra no ambiente do filho (P17). */
  readonly pathEnv?: string | undefined
  readonly pathExt?: string | undefined
  readonly isExecutableFile?: (candidate: string) => Promise<boolean | null>
  /** Alvo inexistente de um symlink, quando o candidato for um link quebrado. */
  readonly brokenLinkTarget?: (candidate: string) => Promise<string | null>
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

/**
 * Alvo de um symlink cujo destino nao existe; `null` quando nao ha link quebrado.
 *
 * `stat` segue o link e devolve ENOENT igual a um caminho que nunca existiu — os dois
 * casos ficam indistinguiveis, e o operador procura o problema no lugar errado. Aqui a
 * diferenca e apurada com `lstat` + `readlink`, e vira diagnostico.
 */
export async function brokenLinkTarget(candidate: string): Promise<string | null> {
  let link: Awaited<ReturnType<typeof lstat>>
  try {
    link = await lstat(candidate)
  } catch {
    return null
  }
  if (!link.isSymbolicLink()) return null
  let target: string
  try {
    target = await readlink(candidate)
  } catch {
    return null
  }
  const absolute = isAbsolute(target) ? target : resolvePath(dirname(candidate), target)
  try {
    await stat(absolute)
    // O alvo existe: se o candidato ainda nao serve, o problema e outro.
    return null
  } catch (error) {
    const code = errorCode(error)
    return code !== null && MISSING_CODES.has(code) ? absolute : null
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
  const linkTargetOf = deps.brokenLinkTarget ?? brokenLinkTarget
  let broken: { readonly candidate: string; readonly target: string } | null = null
  let inert: string | null = null

  for (const candidate of candidates) {
    let verdict: boolean | null
    try {
      verdict = await inspect(candidate)
    } catch (error) {
      const detail = `falha ao inspecionar "${candidate}": ${describeError(error)}`
      return {
        status: 'unknown',
        detail,
        diagnostic: { kind: 'probe-failed', detail, target: candidate },
      }
    }
    if (verdict === true) return { status: 'found', path: candidate }
    if (verdict === false && inert === null) inert = candidate
    if (verdict === null && broken === null) {
      const target = await linkTargetOf(candidate)
      if (target !== null) broken = { candidate, target }
    }
  }

  if (broken !== null) return brokenSymlink(name, broken.candidate, broken.target)
  if (inert !== null) return notExecutable(name, inert)
  return {
    status: 'not-found',
    detail: `"${name}" nao encontrado (${candidates.length} candidato(s) verificados)`,
    diagnostic: {
      kind: 'not-found',
      detail: `"${name}" nao existe em nenhum dos ${candidates.length} candidato(s) do PATH`,
      remediation: `instale a CLI ou aponte "command" para o caminho absoluto do executavel`,
    },
  }
}

function brokenSymlink(name: string, candidate: string, target: string): ExecutableNotFound {
  const detail = `"${name}" e um symlink quebrado: ${candidate} aponta para ${target}, que nao existe`
  return {
    status: 'not-found',
    detail,
    diagnostic: {
      kind: 'broken-symlink',
      detail,
      target,
      remediation: `recrie o link para uma instalacao existente (\`ln -sfn <caminho-real> ${candidate}\`) ou reinstale a CLI`,
    },
  }
}

function notExecutable(name: string, candidate: string): ExecutableNotFound {
  const detail = `"${name}" existe em ${candidate} mas nao e um arquivo executavel`
  return {
    status: 'not-found',
    detail,
    diagnostic: {
      kind: 'not-executable',
      detail,
      target: candidate,
      remediation: `de permissao de execucao (\`chmod +x ${candidate}\`) ou aponte "command" para o binario real`,
    },
  }
}
