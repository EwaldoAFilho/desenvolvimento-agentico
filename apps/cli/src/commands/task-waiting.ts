import type { PathScope } from '@agentic/domain'
import { pathScopeSetsConflict, tryPathScope } from '@agentic/domain'
import type { RunSnapshot, TaskDetail } from '@agentic/schemas'

/**
 * Vocabulario da espera. Uma task parada em `PENDING` ou `READY` sem despacho nao e uma
 * informacao: e uma pergunta. Estes sao os motivos possiveis, cada um com conserto
 * diferente — e todos derivados do estado, nunca de log.
 */
export const WAIT_REASONS = [
  'DEPENDENCIES',
  'RUN_NOT_STARTED',
  'RUN_PAUSED',
  'SCOPE_LOCK',
  'GLOBAL_LIMIT',
  'PROVIDER_CAPACITY',
  'NEXT_TICK',
] as const

export type WaitReason = (typeof WAIT_REASONS)[number]

export interface WaitExplanation {
  readonly reason: WaitReason
  readonly detail: string
  /** Quem esta na frente: tasks, fornecedores ou o proprio run. */
  readonly blockedBy: readonly string[]
}

/** Estados em que a task ainda nao tem agente proprio e depende de alguem sair da frente. */
const WAITING_STATUSES: readonly string[] = ['PENDING', 'READY']

/** Dependencia satisfeita: concluida ou dispensada. Qualquer outra coisa ainda segura. */
const SETTLED: readonly string[] = ['DONE', 'SKIPPED']

/** Ocupa lock de `touches` e vaga global do inicio do despacho ate a tentativa fechar. */
const HOLDING_STATUSES: readonly string[] = ['RUNNING', 'VERIFYING', 'REVIEW', 'INTEGRATING']

function scopesOf(raw: readonly string[]): PathScope[] {
  const out: PathScope[] = []
  for (const value of raw) {
    const scope = tryPathScope(value)
    if (scope !== undefined) out.push(scope)
  }
  return out
}

/**
 * Por que esta task nao esta rodando agora.
 *
 * `undefined` quando a pergunta nao se aplica — a task ja rodou, esta rodando, terminou ou
 * esta `BLOCKED` (que ja tem `blockage`, com motivo proprio).
 */
export function waitExplanationOf(
  detail: TaskDetail,
  snapshot: RunSnapshot,
): WaitExplanation | undefined {
  if (!WAITING_STATUSES.includes(detail.status)) return undefined

  const pending = detail.graph.dependencies.filter((dep) => !SETTLED.includes(dep.status))
  if (pending.length > 0) {
    return {
      reason: 'DEPENDENCIES',
      detail: `${pending.length} dependencia(s) ainda nao concluida(s)`,
      blockedBy: pending.map((dep) => `${dep.id}:${dep.status}`),
    }
  }

  const run = snapshot.run
  if (run.status === 'PAUSED') {
    return {
      reason: 'RUN_PAUSED',
      detail: 'o run esta PAUSED: nenhum despacho novo ate `agentic mission resume`',
      blockedBy: [run.id],
    }
  }
  if (run.status !== 'RUNNING' && run.status !== 'VERIFYING') {
    return {
      reason: 'RUN_NOT_STARTED',
      detail: `o run esta ${run.status}: so um run RUNNING despacha task`,
      blockedBy: [run.id],
    }
  }

  const statusOf = new Map(snapshot.tasks.map((task) => [task.id, task.status]))
  const holding = snapshot.graph.nodes.filter((node) =>
    HOLDING_STATUSES.includes(statusOf.get(node.id) ?? 'PENDING'),
  )
  const mine = scopesOf(detail.scope.touches)
  const conflicting = holding.filter((node) => pathScopeSetsConflict(mine, scopesOf(node.touches)))
  if (conflicting.length > 0) {
    return {
      reason: 'SCOPE_LOCK',
      detail:
        'touches sobrepostos com task em voo: duas tasks em RUNNING nunca compartilham escopo (I2)',
      blockedBy: conflicting.map((node) => node.id),
    }
  }

  if (holding.length >= run.policies.maxParallelTasks) {
    return {
      reason: 'GLOBAL_LIMIT',
      detail: `teto global atingido: ${holding.length}/${run.policies.maxParallelTasks} tasks em voo`,
      blockedBy: holding.map((node) => node.id),
    }
  }

  const full = snapshot.providers.filter(
    (provider) => provider.capacity !== null && provider.running >= provider.capacity,
  )
  if (full.length > 0 && full.length === snapshot.providers.length) {
    return {
      reason: 'PROVIDER_CAPACITY',
      detail: 'todo fornecedor esta no teto de concorrencia (I9)',
      blockedBy: full.map(
        (provider) => `${provider.providerId} ${provider.running}/${provider.capacity}`,
      ),
    }
  }

  return {
    reason: 'NEXT_TICK',
    detail: 'nada segura esta task: ela entra no proximo tick do orquestrador',
    blockedBy: [],
  }
}
