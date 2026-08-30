import { type AgentIdentity, isSameAgentIdentity } from './agent.js'
import type { Attempt } from './attempt.js'
import { type DoneEvidence, isDone } from './done.js'
import type { Actor } from './events.js'
import type { AttemptId, ProviderId, TaskId } from './ids.js'
import { type PathScope, pathScopesConflict } from './path-scope.js'
import type { CapacitySnapshot } from './ports/agent-provider.js'
import type { ReviewPolicy, ReviewPolicyOutcome } from './review.js'
import type { TaskStatus } from './task-run.js'

export const INVARIANT_IDS = [
  'I1',
  'I2',
  'I3',
  'I4',
  'I5',
  'I6',
  'I7',
  'I8',
  'I9',
  'I10',
  'I11',
] as const
export type InvariantId = (typeof INVARIANT_IDS)[number]

export interface InvariantResult {
  readonly id: InvariantId
  readonly ok: boolean
  readonly detail?: string
}

function ok(id: InvariantId): InvariantResult {
  return { id, ok: true }
}

function violated(id: InvariantId, detail: string): InvariantResult {
  return { id, ok: false, detail }
}

/** I1 — toda mutacao de estado grava estado **e** evento na mesma transacao. */
export function checkStateAndEventTogether(tx: {
  readonly stateWrites: number
  readonly eventWrites: number
}): InvariantResult {
  if (tx.stateWrites === 0 && tx.eventWrites === 0) return ok('I1')
  if (tx.stateWrites > 0 && tx.eventWrites > 0) return ok('I1')
  return violated(
    'I1',
    `transacao com ${tx.stateWrites} escrita(s) de estado e ${tx.eventWrites} evento(s)`,
  )
}

export interface RunningTaskScope {
  readonly taskId: TaskId
  readonly touches: readonly PathScope[]
}

/** I2 — duas tasks em RUNNING nunca tem `touches` sobrepostos. */
export function checkNoOverlappingTouches(running: readonly RunningTaskScope[]): InvariantResult {
  for (let i = 0; i < running.length; i += 1) {
    for (let j = i + 1; j < running.length; j += 1) {
      const left = running[i]
      const right = running[j]
      if (left === undefined || right === undefined) continue
      for (const a of left.touches) {
        for (const b of right.touches) {
          if (pathScopesConflict(a, b)) {
            return violated('I2', `${left.taskId} e ${right.taskId} colidem em ${a} / ${b}`)
          }
        }
      }
    }
  }
  return ok('I2')
}

/** I3 — reviewer != executor sempre que requireReview. */
export function checkReviewerIsNotExecutor(input: {
  readonly requireReview: boolean
  readonly executor: AgentIdentity
  readonly reviewer?: AgentIdentity
}): InvariantResult {
  if (!input.requireReview) return ok('I3')
  if (input.reviewer === undefined) return violated('I3', 'requireReview sem revisor registrado')
  return isSameAgentIdentity(input.reviewer, input.executor)
    ? violated('I3', 'revisor e o proprio executor')
    : ok('I3')
}

/** I4 — attemptCount <= maxAttempts. */
export function checkAttemptBudget(input: {
  readonly attemptCount: number
  readonly maxAttempts: number
}): InvariantResult {
  return input.attemptCount <= input.maxAttempts
    ? ok('I4')
    : violated('I4', `${input.attemptCount} > ${input.maxAttempts}`)
}

const FROZEN_ATTEMPT_FIELDS = [
  'id',
  'attemptNumber',
  'startedAt',
  'finishedAt',
  'durationMs',
  'result',
] as const satisfies readonly (keyof Attempt)[]

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

/** I5 — tentativa encerrada nunca e alterada (append-only). */
export function checkAttemptImmutable(before: Attempt, after: Attempt): InvariantResult {
  if (before.finishedAt === undefined) return ok('I5')
  for (const field of FROZEN_ATTEMPT_FIELDS) {
    if (!sameValue(before[field], after[field])) {
      return violated('I5', `campo ${field} alterado em tentativa encerrada ${before.id}`)
    }
  }
  if (before.failureReason?.code !== after.failureReason?.code) {
    return violated('I5', `failureReason alterado em tentativa encerrada ${before.id}`)
  }
  return ok('I5')
}

/** I6 — DONE so com evidencia de escopo, gate (se houver) e revisao (se exigida). */
export function checkDoneEvidence(evidence: DoneEvidence): InvariantResult {
  const check = isDone(evidence)
  return check.ok ? ok('I6') : violated('I6', `${check.reason}: ${check.detail}`)
}

/** I7 — o orquestrador e o unico escritor do estado do run. */
export function checkSingleWriter(actor: Actor): InvariantResult {
  return actor.kind === 'orchestrator'
    ? ok('I7')
    : violated('I7', `ator ${actor.kind} tentou escrever estado do run`)
}

/** I8 — nenhuma task em RUNNING sem workspace lease valido. */
export function checkRunningHasLease(input: {
  readonly status: TaskStatus
  readonly lease?: { readonly attemptId: AttemptId; readonly valid: boolean }
  readonly currentAttemptId?: AttemptId
}): InvariantResult {
  if (input.status !== 'RUNNING') return ok('I8')
  const lease = input.lease
  if (lease === undefined || !lease.valid) return violated('I8', 'RUNNING sem lease valido')
  if (input.currentAttemptId !== undefined && lease.attemptId !== input.currentAttemptId) {
    return violated('I8', 'lease pertence a outra tentativa')
  }
  return ok('I8')
}

/** I9 — nenhum despacho excede `maxConcurrent` do provider escolhido. */
export function checkProviderCapacity(
  snapshot: CapacitySnapshot,
  provider: ProviderId,
): InvariantResult {
  const slot = snapshot.byProvider[provider]
  if (slot === undefined) return violated('I9', `provider ${provider} ausente do retrato`)
  if (slot.running > slot.maxConcurrent) {
    return violated('I9', `${provider}: ${slot.running} > ${slot.maxConcurrent}`)
  }
  if (snapshot.global.active > snapshot.global.maxParallelTasks) {
    return violated('I9', 'paralelismo global excedido')
  }
  return ok('I9')
}

/** I10 — `cross-provider-required` nunca e rebaixada; `preferred` so com registro. */
export function checkPolicyNotSilentlyDowngraded(input: {
  readonly policy: ReviewPolicy
  readonly policyOutcome: ReviewPolicyOutcome
  readonly downgradeEventEmitted?: boolean
}): InvariantResult {
  if (input.policyOutcome !== 'downgraded') return ok('I10')
  if (input.policy === 'cross-provider-required') {
    return violated('I10', 'cross-provider-required nao pode ser rebaixada')
  }
  if (input.policy === 'fresh-session') {
    return violated('I10', 'fresh-session nao tem para onde rebaixar')
  }
  return input.downgradeEventEmitted === true
    ? ok('I10')
    : violated('I10', 'rebaixamento sem evento review.policy_downgraded')
}

/** I11 — todo processo de agente inicia com `cwd` na worktree da tentativa. */
export function checkAgentCwd(input: {
  readonly cwd: string
  readonly worktreePath: string
}): InvariantResult {
  return input.cwd === input.worktreePath
    ? ok('I11')
    : violated('I11', `cwd ${input.cwd} != worktree ${input.worktreePath}`)
}

/** Modulo de invariantes indexado pelo id usado na documentacao. */
export const invariants = {
  I1: checkStateAndEventTogether,
  I2: checkNoOverlappingTouches,
  I3: checkReviewerIsNotExecutor,
  I4: checkAttemptBudget,
  I5: checkAttemptImmutable,
  I6: checkDoneEvidence,
  I7: checkSingleWriter,
  I8: checkRunningHasLease,
  I9: checkProviderCapacity,
  I10: checkPolicyNotSilentlyDowngraded,
  I11: checkAgentCwd,
} as const

export function violations(results: readonly InvariantResult[]): InvariantResult[] {
  return results.filter((result) => !result.ok)
}
