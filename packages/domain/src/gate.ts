import type { AttemptId, GateId, RunId } from './ids.js'

export const GATE_STATUSES = ['PASS', 'FAIL', 'ERROR', 'TIMEOUT'] as const
export type GateStatus = (typeof GATE_STATUSES)[number]

export type GateScope = 'task' | 'mission'

export interface GateCommand {
  readonly run: string
  readonly cwd?: string
  readonly timeoutMs?: number
  /** `false` registra a falha sem reprovar o gate. Ausente = obrigatorio. */
  readonly required?: boolean
}

/** Definicao versionada pelo humano. Agente nunca define a propria regra de qualidade (P09). */
export interface Gate {
  readonly id: GateId
  readonly commands: readonly GateCommand[]
  readonly env: readonly string[]
}

/** Fato reproduzivel: um humano cola o comando no terminal e obtem o mesmo resultado (P08). */
export interface CommandResult {
  readonly command: string
  readonly cwd: string
  readonly exitCode: number | null
  readonly durationMs: number
  readonly stdoutRef?: string
  readonly stderrRef?: string
  readonly truncated: boolean
  readonly timedOut?: boolean
}

export interface GateExecution {
  readonly id: string
  readonly gateId: GateId
  readonly scope: GateScope
  readonly runId: RunId
  readonly attemptId?: AttemptId
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly status: GateStatus
  readonly results: readonly CommandResult[]
}

/** Deriva o veredito do gate a partir dos comandos obrigatorios. Funcao pura. */
export function gateStatusFromResults(
  commands: readonly GateCommand[],
  results: readonly CommandResult[],
): GateStatus {
  let status: GateStatus = 'PASS'
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i]
    if (result === undefined) continue
    if ((commands[i]?.required ?? true) === false) continue
    if (result.timedOut === true) return 'TIMEOUT'
    if (result.exitCode === null) status = 'ERROR'
    else if (result.exitCode !== 0 && status === 'PASS') status = 'FAIL'
  }
  return status
}
