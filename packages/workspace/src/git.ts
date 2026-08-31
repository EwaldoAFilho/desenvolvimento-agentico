import { execFile } from 'node:child_process'
import nodeProcess from 'node:process'
import { WorkspaceError, type WorkspaceStage } from './errors.js'

export interface GitResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface GitOptions {
  readonly cwd: string
  /** Quando true, saida diferente de zero volta como resultado em vez de erro. */
  readonly allowFailure?: boolean
  readonly timeoutMs?: number
  readonly maxBufferBytes?: number
  readonly stage?: WorkspaceStage
  /**
   * Entrada padrao do processo. Existe para comandos que recebem LISTA de caminhos
   * (`hash-object --stdin-paths`, `check-ignore --stdin`): argv tem teto de tamanho no
   * sistema operacional — 32.767 caracteres no Windows — e uma lista longa o bastante
   * transformaria repositorio valido em comando irexecutavel.
   */
  readonly stdin?: string
}

export const DEFAULT_GIT_TIMEOUT_MS = 120_000
export const DEFAULT_GIT_MAX_BUFFER = 64 * 1024 * 1024

/**
 * `LC_ALL=C` porque nunca lemos mensagem de git: decisao sai de exit code e de saida
 * porcelain/`-z`. Locale so afetaria o texto que guardamos como detalhe.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...nodeProcess.env,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  }
}

function describe(args: readonly string[]): string {
  return `git ${args.join(' ')}`
}

export function git(args: readonly string[], options: GitOptions): Promise<GitResult> {
  const stage = options.stage ?? 'acquire'
  return new Promise<GitResult>((resolve, reject) => {
    const child = execFile(
      'git',
      [...args],
      {
        cwd: options.cwd,
        env: gitEnv(),
        timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: options.maxBufferBytes ?? DEFAULT_GIT_MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, exitCode: 0 })
          return
        }
        const exitCode = typeof error.code === 'number' ? error.code : null
        if (exitCode !== null && options.allowFailure === true) {
          resolve({ stdout, stderr, exitCode })
          return
        }
        const detail = (stderr.trim().length > 0 ? stderr : stdout).trim()
        if (exitCode !== null) {
          reject(
            new WorkspaceError(stage, `${describe(args)} falhou (exit ${exitCode})`, {
              detail,
              cause: error,
            }),
          )
          return
        }
        reject(
          new WorkspaceError(stage, `${describe(args)} nao pode ser executado`, {
            detail: error.message,
            cause: error,
          }),
        )
      },
    )
    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => {
        // Processo que morreu antes de ler fecha o cano; o erro real vem pelo exit code.
      })
      child.stdin?.end(options.stdin)
    }
  })
}

/** Saida padrao ja aparada; falha vira `WorkspaceError`. */
export async function gitText(args: readonly string[], options: GitOptions): Promise<string> {
  const result = await git(args, { ...options, allowFailure: false })
  return result.stdout.trim()
}

/** Saida `-z`: separada por NUL, sem aspas nem escape — imune a caminho exotico. */
export function splitNul(raw: string): string[] {
  return raw.split('\0').filter((token) => token.length > 0)
}
