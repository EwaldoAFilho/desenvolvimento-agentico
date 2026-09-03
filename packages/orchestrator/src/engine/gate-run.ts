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
   * Um item por comando cujo grupo de processos ainda existia quando o teto venceu: o pid do
   * lider (o grupo e `-pid`), para sondar de novo na tentativa seguinte de encerramento (C3),
   * ou `null` quando o registro nao trouxe pid — residuo que ninguem consegue sondar e que,
   * por isso, nunca se prova morto (falha fechado, ADR-0014). Presente so quando ha algum.
   */
  readonly residualGroups?: readonly (number | null)[]
}

/** Grupos que o gate nao conseguiu provar mortos: um por comando com `groupTerminated: false`. */
function residualGroupsOf(result: GateRunResult): (number | null)[] {
  const groups: (number | null)[] = []
  for (const record of result.results) {
    if (!record.groupTerminated) groups.push(record.pid)
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
  // Fora do `try`: o residuo e um FATO observado no instante em que o gate rodou, e uma falha
  // posterior (persistir a saida) nao pode apaga-lo — seria devolver a posse com o grupo vivo.
  let residual: { readonly residualGroups?: readonly (number | null)[] } = {}
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
    if (residualGroups.length > 0) residual = { residualGroups }
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
      ...residual,
    }
  }
}
