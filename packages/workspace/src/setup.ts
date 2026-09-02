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
/** Espera maxima pelo `close` do shell depois de derrubar a arvore. */
const KILL_SETTLE_MS = 2_000

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
  /** O chamador cancelou (sinal de abort): a arvore do comando foi encerrada. */
  readonly aborted: boolean
  /** O grupo de processos do comando deixou de existir, confirmado por sonda com teto. */
  readonly groupTerminated: boolean
  readonly durationMs: number
  readonly output: string
}

/** Sonda injetavel para o teste: `true` = o grupo (pgid negativo) ainda existe. */
export interface SetupProcessDeps {
  readonly probeGroup?: (pgid: number) => boolean
  readonly groupGraceMs?: number
}

const DEFAULT_GROUP_GRACE_MS = 2_000
const GROUP_PROBE_INTERVAL_MS = 10

function defaultProbeGroup(pgid: number): boolean {
  try {
    nodeProcess.kill(pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Sinal enviado nao e grupo morto: sonda ate ESRCH ou ate o teto. */
async function confirmGroupGone(pid: number, deps: SetupProcessDeps): Promise<boolean> {
  if (nodeProcess.platform === 'win32') return true
  const probe = deps.probeGroup ?? defaultProbeGroup
  const deadline = Date.now() + (deps.groupGraceMs ?? DEFAULT_GROUP_GRACE_MS)
  for (;;) {
    if (!probe(-pid)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, GROUP_PROBE_INTERVAL_MS))
  }
}

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL_BYTES ? text : text.slice(text.length - OUTPUT_TAIL_BYTES)
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  deps: SetupProcessDeps = {},
): Promise<ShellOutcome> {
  return new Promise<ShellOutcome>((resolvePromise) => {
    const startedAt = Date.now()
    let output = ''
    let timedOut = false
    let aborted = false
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
    let derrubada: NodeJS.Timeout | undefined
    const settle = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (derrubada !== undefined) clearTimeout(derrubada)
      signal?.removeEventListener('abort', onAbort)
      // Antes de responder, a morte do grupo e CONFIRMADA (com teto): responder ao `kill`
      // deixaria o chamador seguir com um descendente ainda terminando uma escrita.
      const pid = child.pid
      const confirmacao = pid === undefined ? Promise.resolve(true) : confirmGroupGone(pid, deps)
      void confirmacao.then((groupTerminated) => {
        resolvePromise({
          exitCode,
          timedOut,
          aborted,
          groupTerminated,
          durationMs: Date.now() - startedAt,
          output,
        })
      })
    }
    /**
     * Derrubar a arvore e ESPERAR o `close` do shell antes de responder: resolver na hora
     * deixaria o chamador seguir com um processo ainda morrendo. O teto existe para um
     * descendente que segure os pipes nao pendurar o encerramento — passado ele, o grupo ja
     * recebeu SIGKILL e o que sobrar nao sobrevive.
     */
    const derrubar = (): void => {
      killTree()
      derrubada = setTimeout(() => settle(null), KILL_SETTLE_MS)
      derrubada.unref?.()
    }
    const onAbort = (): void => {
      aborted = true
      derrubar()
    }
    timer = setTimeout(() => {
      timedOut = true
      derrubar()
    }, timeoutMs)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      output = tail(`${output}${error.message}`)
      settle(null)
    })
    child.on('close', (code) => {
      // O grupo termina com o shell, tambem na saida normal: um daemon que um comando de setup
      // deixe para tras continuaria mutando a worktree depois de o dono ir embora (I15).
      killTree()
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
  signal?: AbortSignal,
  deps: SetupProcessDeps = {},
): Promise<WorkspaceSetupResult> {
  if (setup === undefined) return EMPTY_SETUP_RESULT
  const cancelado = (command: string): WorkspaceError =>
    new WorkspaceError('setup', `workspaceSetup cancelado antes de concluir: ${command}`, {
      detail: 'o control plane esta encerrando; a worktree e descartada e nada e presumido',
    })

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
    if (signal?.aborted === true) throw cancelado(command.run)
    const cwd = command.cwd === undefined ? target : resolve(target, command.cwd)
    const outcome = await runShell(
      command.run,
      cwd,
      command.timeoutMs ?? defaultTimeout,
      signal,
      deps,
    )
    commands.push({
      run: command.run,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      timedOut: outcome.timedOut,
    })
    if (!outcome.groupTerminated) {
      // Nao e "falhou": e "nao consegui provar que parou". Quem encerra precisa saber.
      throw new WorkspaceError(
        'setup',
        `grupo de processos do comando de workspaceSetup ainda vivo depois do teto: ${command.run}`,
        { detail: outcome.output.trim(), residualProcess: true },
      )
    }
    if (outcome.aborted) throw cancelado(command.run)
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
