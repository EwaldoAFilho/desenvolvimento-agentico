import type {
  AttemptId,
  CommandResult,
  FailureReason,
  GateExecution,
  GateId,
  GateScope,
  RunId,
} from '@agentic/domain'
import type { GateCommandRecord, GateProfiles, GateRunResult } from '@agentic/gates'
import { describeError } from './errors.js'
import type { ArtifactWriter, GateExecutor } from './types.js'

export interface RunGateInput {
  readonly gates: GateProfiles
  readonly gateRunner: GateExecutor
  readonly artifacts: ArtifactWriter
  readonly runId: RunId
  readonly gateId: GateId
  readonly scope: GateScope
  readonly cwd: string
  readonly attemptId?: AttemptId
  /** Diretorio relativo do run onde as saidas viram artefato. */
  readonly directory: string
  /** Encerramento do control plane: o comando em curso e cancelado e o resultado descartado. */
  readonly signal?: AbortSignal
}

export interface GateOutcome {
  readonly execution?: GateExecution
  readonly failure?: FailureReason
  readonly cwd: string
  /**
   * Pids dos comandos cujo grupo de processos ainda existia quando o teto venceu. Presente so
   * quando ha algum: o encerramento nao pode presumir que pararam, e precisa do pid para
   * sondar cada grupo (`-pid`) de novo na tentativa seguinte (C3).
   */
  readonly residualGroups?: readonly number[]
}

/** Grupos que o gate nao conseguiu provar mortos: um por comando com `groupTerminated: false`. */
function residualGroupsOf(result: GateRunResult): number[] {
  const groups: number[] = []
  for (const record of result.results) {
    if (!record.groupTerminated && record.pid !== null) groups.push(record.pid)
  }
  return groups
}

async function persistStream(
  input: RunGateInput,
  record: GateCommandRecord,
  stream: 'stdout' | 'stderr',
): Promise<string | undefined> {
  const output = record[stream]
  if (output.text.length === 0) return undefined
  const written = await input.artifacts.write({
    runId: input.runId,
    kind: `gate-${stream}`,
    relativePath: `${input.directory}/gate-${input.gateId}-${record.index}.${stream}`,
    content: output.text,
  })
  return written.path
}

/**
 * Normaliza o resultado do runner para o registro fechado do dominio: comando exato, cwd,
 * exit code e ponteiro para a saida persistida — o que um humano cola no terminal (P08).
 */
async function toCommandResults(
  input: RunGateInput,
  result: GateRunResult,
): Promise<CommandResult[]> {
  const results: CommandResult[] = []
  for (const record of result.results) {
    results.push({
      command: record.command,
      cwd: record.cwd,
      exitCode: record.exitCode,
      durationMs: record.durationMs,
      stdoutRef: await persistStream(input, record, 'stdout'),
      stderrRef: await persistStream(input, record, 'stderr'),
      truncated: record.truncated,
      timedOut: record.timedOut,
    })
  }
  return results
}

/**
 * Roda o perfil versionado no workspace informado. Perfil ausente ou allowlist recusada
 * sao erro de configuracao (POLICY_VIOLATION): repetir a tentativa nao corrigiria.
 */
export async function runGate(input: RunGateInput): Promise<GateOutcome> {
  try {
    const gate = input.gates.require(input.gateId)
    const result = await input.gateRunner.run({
      gate,
      scope: input.scope,
      cwd: input.cwd,
      runId: input.runId,
      attemptId: input.attemptId,
      envAllow: gate.env,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const residualGroups = residualGroupsOf(result)
    const residual = residualGroups.length === 0 ? {} : { residualGroups }
    // Gate cancelado nao e medicao: nao vira artefato nem execucao. O proximo dono refaz.
    if (input.signal?.aborted === true) {
      return {
        failure: {
          code: 'INTERRUPTED',
          detail: `gate ${input.gateId} cancelado pelo encerramento do control plane`,
        },
        cwd: result.cwd,
        ...residual,
      }
    }
    const execution: GateExecution = {
      id: result.id,
      gateId: result.gateId,
      scope: result.scope,
      runId: result.runId,
      attemptId: input.attemptId,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      status: result.status,
      results: await toCommandResults(input, result),
    }
    return { execution, cwd: result.cwd, ...residual }
  } catch (error) {
    return {
      failure: {
        code: 'POLICY_VIOLATION',
        detail: `gate ${input.gateId} nao pode ser executado: ${describeError(error)}`,
      },
      cwd: input.cwd,
    }
  }
}
