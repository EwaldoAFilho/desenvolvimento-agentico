import type { DiffStatDto, TaskDetail } from '@agentic/schemas'
import { type AgentLogArtifact, agentLogArtifacts } from './agent-log.js'
import { type GateReport, gateReportOf } from './failure.js'
import type { TaskStatus } from './status.js'

/**
 * `NO_CHANGES` explicado.
 *
 * Caso real de DA-DOGFOOD-001: o agente investigou, concluiu **corretamente** que a premissa
 * da task era falsa, recusou-se a inventar trabalho fora do `touches` e nao alterou nada. O
 * produto registrou `NO_CHANGES` — nao fingiu sucesso e nao marcou `DONE`.
 *
 * Isso nao pode parecer falha misteriosa. O que muda aqui e **a leitura**: o desfecho
 * continua sendo o que o dominio registrou (`status` + `failureCode`), e nenhuma informacao
 * nova e inventada — cada frase abaixo cita um fato medido pelo control plane.
 */
export type NoChangesFact = 'investigation' | 'no-diff' | 'not-done' | 'where-to-read'

export interface NoChangesStatement {
  readonly key: NoChangesFact
  readonly text: string
}

export interface NoChangesView {
  /** Desfecho do dominio, repetido sem traducao: a UI le, nao decide. */
  readonly outcome: TaskStatus
  readonly failureCode: 'NO_CHANGES'
  readonly failureDetail?: string
  readonly attempt?: { readonly number: number; readonly max: number }
  readonly diff: DiffStatDto
  readonly filesChanged: number
  readonly investigationFinished: boolean
  readonly gate: GateReport
  readonly logs: readonly AgentLogArtifact[]
  readonly statements: readonly NoChangesStatement[]
}

/** O agente chegou ao fim por conta propria? Quem responde e o evento, nao o relato dele. */
function investigationFinishedOf(task: TaskDetail): boolean {
  const byEvent = task.events.some(
    (event) => event.type === 'attempt.finished' || event.type === 'task.failed',
  )
  if (byEvent) return true
  return task.attempts.some((attempt) => attempt.finishedAt !== undefined)
}

function noChangesDetailOf(task: TaskDetail): string | undefined | null {
  // A tentativa corrente manda. Se ela falhou por outro codigo, esta leitura nao se aplica:
  // exibir um `NO_CHANGES` antigo debaixo de uma falha mais nova faria a tela contradizer o
  // dominio — e a diffStat mostrada e a da tentativa corrente, nao a daquela.
  if (task.failure !== undefined) {
    return task.failure.failureCode === 'NO_CHANGES' ? task.failure.detail : null
  }
  // Sem falha corrente (task reescalonada): vale a ULTIMA tentativa encerrada com falha.
  const attempt = [...task.attempts].reverse().find((candidate) => candidate.failure !== undefined)
  if (attempt?.failure?.failureCode !== 'NO_CHANGES') return null
  return attempt.failure.detail
}

export function noChangesViewOf(task: TaskDetail): NoChangesView | undefined {
  const detail = noChangesDetailOf(task)
  if (detail === null) return undefined

  const diff = task.facts.diffStat
  const finished = investigationFinishedOf(task)
  const gate = gateReportOf(task)
  const logs = agentLogArtifacts(task.events)
  const attempt = task.execution.attempt

  const where =
    logs[0] === undefined
      ? 'nenhum log do agente foi persistido: não há registro do que o agente concluiu'
      : `o que o agente concluiu está no log da tentativa: ${logs[0].path}`

  return {
    outcome: task.status,
    failureCode: 'NO_CHANGES',
    failureDetail: detail,
    attempt,
    diff,
    filesChanged: task.facts.filesChanged.length,
    investigationFinished: finished,
    gate,
    logs,
    statements: [
      {
        key: 'investigation',
        text: finished
          ? 'o agente concluiu a investigação e encerrou a tentativa'
          : 'a tentativa terminou sem registro de encerramento do agente',
      },
      {
        key: 'no-diff',
        text: `nenhuma alteração observada no repositório — ${diff.files} arquivo(s), +${diff.added} −${diff.removed} medidos na worktree`,
      },
      {
        key: 'not-done',
        text: `a task não foi marcada DONE automaticamente — o desfecho registrado é ${task.status} · NO_CHANGES (I6: DONE exige evidência)`,
      },
      { key: 'where-to-read', text: where },
    ],
  }
}

/** A tela precisa dizer que isto e leitura, e nao um estado novo do dominio. */
export const NO_CHANGES_READING =
  'leitura da interface sobre o desfecho registrado — nenhum estado novo foi criado'
