import { spawn } from 'node:child_process'
import { lstat, mkdir, readlink, stat, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import nodeProcess from 'node:process'
import { WorkspaceError } from './errors.js'

export interface WorkspaceSetupCommand {
  readonly run: string
  /** Relativo a worktree. Ausente = raiz da worktree. */
  readonly cwd?: string
  readonly timeoutMs?: number
}

/**
 * Declarado em `project.yaml` (MISSION-FORMAT 2). Sem isto, uma worktree recem-criada nao
 * tem `node_modules` nem `.env` e TODO gate reprovaria por motivo alheio ao agente.
 */
export interface WorkspaceSetup {
  /** Diretorios/arquivos ligados por symlink a partir da raiz do repositorio. */
  readonly link?: readonly string[]
  readonly commands?: readonly (string | WorkspaceSetupCommand)[]
  readonly timeoutMs?: number
}

export type SetupSkipReason = 'source-missing' | 'same-path'

export interface SetupLinkSkip {
  readonly name: string
  readonly reason: SetupSkipReason
}

export interface SetupCommandResult {
  readonly run: string
  readonly exitCode: number | null
  readonly durationMs: number
  readonly timedOut: boolean
}

export interface WorkspaceSetupResult {
  readonly linked: readonly string[]
  readonly skipped: readonly SetupLinkSkip[]
  readonly commands: readonly SetupCommandResult[]
}

export const DEFAULT_WORKSPACE_SETUP_TIMEOUT_MS = 600_000
export const EMPTY_SETUP_RESULT: WorkspaceSetupResult = { linked: [], skipped: [], commands: [] }

const OUTPUT_TAIL_BYTES = 8192

export function normalizeSetupCommand(
  command: string | WorkspaceSetupCommand,
): WorkspaceSetupCommand {
  return typeof command === 'string' ? { run: command } : command
}

function assertRelativeName(name: string): void {
  if (name.trim().length === 0) throw new WorkspaceError('setup', 'link vazio em workspaceSetup')
  if (isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
    throw new WorkspaceError('setup', `link de workspaceSetup nao pode ser absoluto: ${name}`)
  }
  if (name.split(/[\\/]/).includes('..')) {
    throw new WorkspaceError('setup', `link de workspaceSetup nao pode escapar da raiz: ${name}`)
  }
}

async function linkOne(
  target: string,
  repoRoot: string,
  name: string,
): Promise<SetupLinkSkip | undefined> {
  assertRelativeName(name)
  const source = resolve(repoRoot, name)
  const destination = resolve(target, name)
  // Arvore compartilhada: a raiz E o alvo, ligar seria um symlink para si mesmo.
  if (source === destination) return { name, reason: 'same-path' }

  const sourceStat = await stat(source).catch(() => null)
  // Fonte ausente nao vira link quebrado: registramos o pulo em vez de plantar um erro
  // que so apareceria como falha de gate depois.
  if (sourceStat === null) return { name, reason: 'source-missing' }

  const existing = await lstat(destination).catch(() => null)
  if (existing !== null) {
    if (existing.isSymbolicLink()) {
      const current = await readlink(destination)
      if (resolve(dirname(destination), current) === source) return undefined
    }
    throw new WorkspaceError(
      'setup',
      `caminho ja existe na worktree e nao e o link esperado: ${name}`,
      { detail: destination },
    )
  }

  await mkdir(dirname(destination), { recursive: true })
  await symlink(source, destination, sourceStat.isDirectory() ? 'dir' : 'file')
  return undefined
}

interface ShellOutcome {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number
  readonly output: string
}

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL_BYTES ? text : text.slice(text.length - OUTPUT_TAIL_BYTES)
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellOutcome> {
  return new Promise<ShellOutcome>((resolvePromise) => {
    const startedAt = Date.now()
    let output = ''
    let timedOut = false
    let settled = false
    // `detached` no POSIX torna o shell lider de grupo: no timeout matamos a arvore
    // inteira, senao um neto segurando o pipe deixaria o setup pendurado para sempre.
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...nodeProcess.env },
      windowsHide: true,
      detached: nodeProcess.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const killTree = (): void => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        if (nodeProcess.platform === 'win32') child.kill('SIGKILL')
        else nodeProcess.kill(-pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const collect = (chunk: Buffer | string): void => {
      output = tail(output + String(chunk))
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    let timer: NodeJS.Timeout | undefined
    const settle = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolvePromise({ exitCode, timedOut, durationMs: Date.now() - startedAt, output })
    }
    timer = setTimeout(() => {
      timedOut = true
      killTree()
      settle(null)
    }, timeoutMs)
    timer.unref?.()
    child.on('error', (error) => {
      output = tail(`${output}${error.message}`)
      settle(null)
    })
    child.on('close', (code) => {
      settle(code)
    })
  })
}

/**
 * Roda DEPOIS de criar a worktree e ANTES de liberar para o agente. Qualquer falha aqui e
 * `WORKSPACE_ERROR` — jamais falha de gate.
 */
export async function runWorkspaceSetup(
  target: string,
  repoRoot: string,
  setup: WorkspaceSetup | undefined,
): Promise<WorkspaceSetupResult> {
  if (setup === undefined) return EMPTY_SETUP_RESULT

  const linked: string[] = []
  const skipped: SetupLinkSkip[] = []
  for (const name of setup.link ?? []) {
    const skip = await linkOne(target, repoRoot, name)
    if (skip === undefined) linked.push(name)
    else skipped.push(skip)
  }

  const commands: SetupCommandResult[] = []
  const defaultTimeout = setup.timeoutMs ?? DEFAULT_WORKSPACE_SETUP_TIMEOUT_MS
  for (const raw of setup.commands ?? []) {
    const command = normalizeSetupCommand(raw)
    const cwd = command.cwd === undefined ? target : resolve(target, command.cwd)
    const outcome = await runShell(command.run, cwd, command.timeoutMs ?? defaultTimeout)
    commands.push({
      run: command.run,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      timedOut: outcome.timedOut,
    })
    if (outcome.timedOut) {
      throw new WorkspaceError(
        'setup',
        `comando de workspaceSetup excedeu o tempo: ${command.run}`,
        {
          detail: outcome.output.trim(),
        },
      )
    }
    if (outcome.exitCode !== 0) {
      throw new WorkspaceError('setup', `comando de workspaceSetup falhou: ${command.run}`, {
        detail: `exit ${String(outcome.exitCode)}\n${outcome.output.trim()}`,
      })
    }
  }

  return { linked, skipped, commands }
}
