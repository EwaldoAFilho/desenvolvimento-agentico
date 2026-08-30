import type {
  AgentOutcomeStatus,
  FailureReason,
  Observation,
  RunId,
  TaskId,
  Workspace,
} from '@agentic/domain'
import { failureReasonOf } from './errors.js'
import type { ArtifactWriter, AttemptWorkspaceProvider } from './types.js'

export interface ObserveInput {
  readonly workspaces: AttemptWorkspaceProvider
  readonly artifacts: ArtifactWriter
  readonly runId: RunId
  readonly taskId: TaskId
  readonly attemptNumber: number
  readonly workspace: Workspace
  readonly agentStatus: AgentOutcomeStatus
  readonly enforceTouches: boolean
  readonly commitMessage: string
}

export interface ObserveOutcome {
  readonly observation?: Observation
  readonly failure?: FailureReason
}

const AGENT_FAILURES: Readonly<Record<AgentOutcomeStatus, FailureReason | undefined>> = {
  completed: undefined,
  failed: { code: 'AGENT_ERROR', detail: 'agente encerrou com status failed' },
  timeout: { code: 'AGENT_TIMEOUT', detail: 'agente excedeu o tempo da tentativa' },
  cancelled: { code: 'INTERRUPTED', detail: 'tentativa cancelada antes de concluir' },
}

export function attemptDirectory(taskId: TaskId, attemptNumber: number): string {
  return `attempts/${taskId}-a${attemptNumber}`
}

/**
 * O contraponto factual do `claims` (P05/ADR-0006): diff medido por nos, escopo apurado
 * por nos e commit criado por nos. Nada aqui le o que o agente disse ter feito.
 */
export async function observeAttempt(input: ObserveInput): Promise<ObserveOutcome> {
  try {
    const measured = await input.workspaces.diff(input.workspace)
    const directory = attemptDirectory(input.taskId, input.attemptNumber)
    let diffRef = measured.diffRef
    const patch = measured.patch ?? ''
    if (patch.length > 0) {
      const record = await input.artifacts.write({
        runId: input.runId,
        kind: 'patch',
        relativePath: `${directory}/patch.diff`,
        content: patch,
      })
      diffRef = record.path
    }
    const observed: Observation = {
      filesChanged: measured.filesChanged,
      diffStat: measured.diffStat,
      diffRef,
      outOfScopePaths: measured.outOfScopePaths,
      commit: measured.commit,
      scopeCheck: measured.scopeCheck,
    }

    const agentFailure = AGENT_FAILURES[input.agentStatus]
    if (agentFailure !== undefined) return { observation: observed, failure: agentFailure }

    // P04: escopo declarado e contrato. Violacao reprova a tentativa antes de qualquer gate.
    if (input.enforceTouches && observed.scopeCheck === 'VIOLATION') {
      return {
        observation: observed,
        failure: {
          code: 'SCOPE_VIOLATION',
          detail: `caminhos fora de touches: ${observed.outOfScopePaths.join(', ')}`,
        },
      }
    }
    if (observed.diffStat.files === 0) {
      return {
        observation: observed,
        failure: { code: 'NO_CHANGES', detail: 'a tentativa nao alterou nenhum arquivo' },
      }
    }

    const commit = await input.workspaces.commit(input.workspace, input.commitMessage)
    if (!commit.changed) {
      return {
        observation: observed,
        failure: { code: 'NO_CHANGES', detail: 'nada a commitar no escopo declarado' },
      }
    }
    return { observation: { ...observed, commit: commit.sha } }
  } catch (error) {
    return { failure: failureReasonOf(error, 'WORKSPACE_ERROR') }
  }
}
