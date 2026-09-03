import { createHash, randomUUID } from 'node:crypto'
import nodeProcess from 'node:process'
import type { Gate, GateCommand } from '@agentic/domain'
import { gateStatusFromResults } from '@agentic/domain'
import type { CapturedRun, RuntimeDeps } from '@agentic/process'
import { buildEnv, redactSecrets, runCaptured } from '@agentic/process'
import { displayGateCwd, resolveGateCwd, resolveGateWorkspace } from './cwd.js'
import { describeUnknownError, GateError, isGateError } from './errors.js'
import { tokenizeCommandLine } from './tokenize.js'
import type {
  GateCommandOutput,
  GateCommandRecord,
  GateRunnerDeps,
  GateRunRequest,
  GateRunResult,
  SkippedGateCommand,
} from './types.js'

/** Teto por comando quando `gates.yaml` nao declara `timeoutMs`. */
export const DEFAULT_GATE_TIMEOUT_MS = 600_000
/** Captura por stream. Acima disto o texto e truncado; o digest continua sendo do total. */
export const DEFAULT_GATE_MAX_OUTPUT_BYTES = 256 * 1024

const EMPTY_DIGEST = createHash('sha256').digest('hex')

/**
 * Executa um perfil de gate no workspace da tentativa e devolve o fato medido.
 *
 * A API so aceita `Gate` — estrutura que `loadGateProfiles` produz a partir do arquivo
 * versionado. Nao existe sobrecarga que receba string de comando: um agente nao tem por
 * onde injetar um gate proprio (P09).
 */
export class GateRunner {
  readonly #now: () => number
  readonly #newId: () => string
  readonly #envSource: NodeJS.ProcessEnv
  readonly #maxOutputBytes: number
  readonly #defaultTimeoutMs: number
  readonly #processDeps: RuntimeDeps | undefined

  constructor(deps: GateRunnerDeps = {}) {
    this.#now = deps.now ?? Date.now
    this.#newId = deps.newId ?? ((): string => `gate_${randomUUID()}`)
    this.#envSource = deps.envSource ?? nodeProcess.env
    this.#maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_GATE_MAX_OUTPUT_BYTES
    this.#defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS
    this.#processDeps = deps.processDeps
  }

  async run(request: GateRunRequest): Promise<GateRunResult> {
    const workspace = resolveGateWorkspace(request.cwd)
    const envAllow = effectiveEnvAllow(request.gate, request.envAllow)
    const env = buildEnv(envAllow, this.#envSource)
    const startedAt = new Date(this.#now())

    const results: GateCommandRecord[] = []
    const skipped: SkippedGateCommand[] = []
    let abortedAt: number | null = null

    for (let index = 0; index < request.gate.commands.length; index += 1) {
      const command = request.gate.commands[index]
      if (command === undefined) continue
      const required = command.required ?? true

      // Cancelado pelo chamador: o que nao rodou fica registrado como nao medido, e a
      // razao e outra — ninguem reprovou, o control plane esta encerrando.
      if (request.signal?.aborted === true) {
        skipped.push({
          index,
          command: command.run,
          cwd: displayGateCwd(workspace, command.cwd),
          required,
          reason: 'ABORTED',
          after: results.length - 1,
        })
        continue
      }

      if (abortedAt !== null) {
        skipped.push({
          index,
          command: command.run,
          cwd: displayGateCwd(workspace, command.cwd),
          required,
          reason: 'FAIL_FAST',
          after: abortedAt,
        })
        continue
      }

      const record = await this.#runCommand(
        command,
        index,
        required,
        workspace,
        env,
        request.signal,
      )
      results.push(record)
      // Fail-fast: seguir depois de um obrigatorio que falhou so produziria ruido, e o
      // relatorio precisa dizer que os proximos NAO foram medidos.
      if (required && isFailure(record)) abortedAt = index
    }

    const finishedAt = new Date(this.#now())
    return {
      id: this.#newId(),
      gateId: request.gate.id,
      scope: request.scope,
      runId: request.runId,
      attemptId: request.attemptId,
      startedAt,
      finishedAt,
      status: gateStatusFromResults(request.gate.commands, results),
      results,
      skipped,
      residualProcess: results.some((record) => !record.groupTerminated),
      cwd: workspace,
      envAllow,
    }
  }

  async #runCommand(
    command: GateCommand,
    index: number,
    required: boolean,
    workspace: string,
    env: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<GateCommandRecord> {
    const startedAt = new Date(this.#now())
    let cwd = workspace
    let argv: string[]

    try {
      cwd = resolveGateCwd(workspace, command.cwd)
      argv = tokenizeCommandLine(command.run)
    } catch (error) {
      return this.#refused(command, index, required, cwd, startedAt, error)
    }

    const executable = argv[0]
    if (executable === undefined) {
      return this.#refused(
        command,
        index,
        required,
        cwd,
        startedAt,
        new GateError('GATE_COMMAND_SYNTAX', 'comando de gate sem executavel', command.run),
      )
    }

    const run: CapturedRun = await runCaptured(
      {
        command: executable,
        args: argv.slice(1),
        cwd,
        env,
        timeoutMs: command.timeoutMs ?? this.#defaultTimeoutMs,
        maxOutputBytes: this.#maxOutputBytes,
        ...(signal === undefined ? {} : { signal }),
      },
      this.#processDeps,
    )

    const stdout = toOutput(run.stdout, run.stdoutTruncated, run.stdoutDigest)
    const stderr = toOutput(run.stderr, run.stderrTruncated, run.stderrDigest)

    return {
      index,
      // Linha exata do arquivo versionado: e ela que o humano cola no terminal (P08).
      command: command.run,
      cwd,
      required,
      argv,
      exitCode: run.code,
      signal: run.signal,
      timedOut: run.timedOut,
      groupTerminated: run.groupTerminated,
      pid: run.pid,
      durationMs: run.durationMs,
      startedAt,
      finishedAt: new Date(this.#now()),
      truncated: stdout.truncated || stderr.truncated,
      stdout,
      stderr,
      error:
        run.spawnError === undefined
          ? undefined
          : { code: run.spawnError.code, message: run.spawnError.message },
    }
  }

  #refused(
    command: GateCommand,
    index: number,
    required: boolean,
    cwd: string,
    startedAt: Date,
    error: unknown,
  ): GateCommandRecord {
    const code = isGateError(error) ? error.code : 'GATE_COMMAND_REFUSED'
    const message = describeUnknownError(error)
    const finishedAt = new Date(this.#now())
    return {
      groupTerminated: true,
      pid: null,
      index,
      command: command.run,
      cwd,
      required,
      argv: [],
      // Sem processo nao ha exit code: `null` vira ERROR no veredito do dominio.
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      startedAt,
      finishedAt,
      truncated: false,
      stdout: emptyOutput(),
      stderr: toOutput(`${code}: ${message}\n`, false, EMPTY_DIGEST),
      error: { code, message },
    }
  }
}

/**
 * A allowlist do pedido nunca amplia a do arquivo versionado. Chamador que pede variavel
 * nao declarada leva erro alto — silenciar seria abrir caminho para injetar ambiente por
 * fora do arquivo que o humano revisou (P09).
 */
export function effectiveEnvAllow(gate: Gate, requested: readonly string[]): readonly string[] {
  const declared = new Set(gate.env)
  const extra = requested.filter((name) => !declared.has(name))
  if (extra.length > 0) {
    throw new GateError(
      'GATE_ENV_NOT_ALLOWED',
      `variavel fora da allowlist declarada em gates.yaml: ${extra.join(', ')}`,
      `allowlist do gate ${gate.id}: ${gate.env.join(', ') || '(vazia)'}`,
    )
  }
  return Object.freeze([...new Set(requested)])
}

function isFailure(record: GateCommandRecord): boolean {
  return record.timedOut || record.exitCode === null || record.exitCode !== 0
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function toOutput(text: string, truncated: boolean, digest: string): GateCommandOutput {
  const redacted = redactSecrets(text)
  return { text: redacted, truncated, digest, artifactDigest: sha256(redacted) }
}

function emptyOutput(): GateCommandOutput {
  return { text: '', truncated: false, digest: EMPTY_DIGEST, artifactDigest: EMPTY_DIGEST }
}
