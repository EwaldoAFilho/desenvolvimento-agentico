import type { AttemptId, DomainEvent, ProviderId, RunId, TaskId } from '@agentic/domain'
import { isRunId, RECOVERABLE_ACTIVE_RUN_STATUSES } from '@agentic/domain'
import type { Persistence } from '@agentic/persistence'
import type { ProviderHealthDto } from '@agentic/schemas'

/**
 * Runs que ainda podem ter agente em voo. Run terminal nao tem, e nao ha por que abrir.
 *
 * E a MESMA lista que I13 usa para decidir quem ganha dono no boot, e por um motivo so:
 * ambas perguntam se o run ainda esta operacionalmente ativo. Manter duas copias era
 * convidar a que uma andasse sem a outra — a regra mora no dominio.
 */
export const LIVE_RUN_STATUSES: readonly string[] = RECOVERABLE_ACTIVE_RUN_STATUSES

/**
 * Onde existe processo de agente: o executor enquanto a task esta `RUNNING`, o revisor
 * enquanto esta `REVIEW`. `VERIFYING` e `INTEGRATING` sao trabalho NOSSO (gate e merge),
 * nao ocupam vaga de fornecedor.
 */
export const IN_FLIGHT_TASK_STATUSES: readonly string[] = ['RUNNING', 'REVIEW']

export type AgentSlot = 'executor' | 'reviewer'

export interface InFlightAgent {
  readonly runId: RunId
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly providerId: ProviderId
  readonly slot: AgentSlot
}

export interface RunningTally {
  /** Quantos agentes em voo por fornecedor, apurados no banco. */
  readonly byProvider: Readonly<Record<string, number>>
  readonly agents: readonly InFlightAgent[]
}

export const EMPTY_TALLY: RunningTally = { byProvider: {}, agents: [] }

/**
 * `attemptId` -> fornecedor do revisor pedido. A `Review` so e persistida com veredito,
 * entao enquanto a task esta em `REVIEW` quem sabe o fornecedor do revisor e o evento.
 */
function reviewersOf(events: readonly DomainEvent[]): Map<AttemptId, ProviderId> {
  const out = new Map<AttemptId, ProviderId>()
  for (const event of events) {
    if (event.type !== 'review.requested') continue
    if (event.attemptId === undefined) continue
    out.set(event.attemptId, event.payload.reviewer.providerId)
  }
  return out
}

/**
 * Agentes em voo segundo o BANCO.
 *
 * O `CapacityLedger` do registry so conhece o que o PROPRIO processo despachou: lido de
 * fora do processo que orquestra, ele responde zero para tudo. Um numero que so e
 * verdadeiro dentro de um processo e pior que numero nenhum — entao a contagem exposta
 * pelas interfaces vem daqui, do estado persistido, que e o mesmo para todo leitor.
 */
export async function inFlightAgents(persistence: Persistence): Promise<InFlightAgent[]> {
  const out: InFlightAgent[] = []
  for (const row of persistence.queries.listRuns({ status: LIVE_RUN_STATUSES })) {
    if (!isRunId(row.id)) continue
    const runId = row.id
    const taskRuns = await persistence.runs.loadTaskRuns(runId)
    const active = taskRuns.filter(
      (task) =>
        task.currentAttemptId !== undefined && IN_FLIGHT_TASK_STATUSES.includes(task.status),
    )
    if (active.length === 0) continue

    const attempts = await persistence.runs.loadAttempts(runId)
    const byId = new Map(attempts.map((attempt) => [attempt.id, attempt]))
    const reviewers = reviewersOf(
      await persistence.events.list(runId, { types: ['review.requested'] }),
    )

    for (const task of active) {
      const attemptId = task.currentAttemptId
      if (attemptId === undefined) continue
      const attempt = byId.get(attemptId)
      // Tentativa encerrada nao tem processo vivo, mesmo que o estado da task esteja atrasado.
      if (attempt === undefined || attempt.finishedAt !== undefined) continue
      if (task.status === 'REVIEW') {
        const providerId = reviewers.get(attemptId)
        // Sem revisor registrado nao ha a quem debitar: nao inventamos fornecedor.
        if (providerId === undefined) continue
        out.push({ runId, taskId: task.taskId, attemptId, providerId, slot: 'reviewer' })
        continue
      }
      out.push({
        runId,
        taskId: task.taskId,
        attemptId,
        providerId: attempt.executor.providerId,
        slot: 'executor',
      })
    }
  }
  return out
}

export function tallyOf(agents: readonly InFlightAgent[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const agent of agents) out[agent.providerId] = (out[agent.providerId] ?? 0) + 1
  return out
}

export async function persistedRunning(persistence: Persistence): Promise<RunningTally> {
  const agents = await inFlightAgents(persistence)
  return { agents, byProvider: tallyOf(agents) }
}

/**
 * Substitui `running` pelo numero derivado do estado persistido. Fornecedor sem tentativa
 * em voo recebe `0` explicito — ausencia de entrada nao vira "nao apurado".
 */
export function applyPersistedRunning(
  health: readonly ProviderHealthDto[],
  tally: RunningTally,
): ProviderHealthDto[] {
  return health.map((entry) => ({
    ...entry,
    running: tally.byProvider[entry.providerId] ?? 0,
  }))
}
