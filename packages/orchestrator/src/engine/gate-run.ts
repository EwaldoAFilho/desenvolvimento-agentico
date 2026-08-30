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
}

export interface GateOutcome {
  readonly execution?: GateExecution
  readonly failure?: FailureReason
  readonly cwd: string
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
    })
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
    return { execution, cwd: result.cwd }
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
