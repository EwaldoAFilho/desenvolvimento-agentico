import type { AgentIdentity } from './agent.js'
import type { AttemptResult, DispatchReason } from './attempt.js'
import type { EvidenceRef, Observation } from './evidence.js'
import type { FailureReason } from './failure-codes.js'
import type { CommandResult, GateStatus } from './gate.js'
import type { AttemptId, GateId, MissionId, ProviderId, RunId, TaskId } from './ids.js'
import type { IntegrationStatus } from './integration.js'
import type { ReviewPolicy, ReviewVerdict } from './review.js'
import type { Blockage } from './task-run.js'
import type { WorkspaceRef } from './workspace.js'

export const EVENT_NAMESPACES = [
  'run',
  'task',
  'attempt',
  'gate',
  'review',
  'workspace',
  'policy',
  'human',
] as const
export type EventNamespace = (typeof EVENT_NAMESPACES)[number]

export type ActorKind = 'orchestrator' | 'human' | 'agent' | 'system'

export interface Actor {
  readonly kind: ActorKind
  readonly id?: string
}

/** Namespace estavel por prefixo. Payload tipado por tipo de evento. */
export interface EventPayloadMap {
  'run.created': { readonly missionId: MissionId; readonly specHash: string }
  'run.approved': { readonly approvedBy: string; readonly warnings: number }
  'run.started': { readonly warningsAccepted: boolean }
  'run.paused': { readonly reason?: string }
  'run.resumed': { readonly reason?: string }
  'run.blocked': { readonly blockedTaskIds: readonly TaskId[] }
  'run.verifying': { readonly gateId?: GateId }
  'run.completed': { readonly missionGateExecutionId?: string }
  'run.failed': { readonly reason: string }
  'run.cancelled': { readonly reason?: string }

  'task.created': { readonly dependencies: readonly TaskId[] }
  'task.ready': { readonly unblockedBy: readonly TaskId[] }
  'task.dispatched': {
    readonly executor: AgentIdentity
    readonly dispatchReason: DispatchReason
  }
  'task.verifying': { readonly attemptId: AttemptId }
  'task.review_requested': { readonly policy: ReviewPolicy; readonly reviewer: AgentIdentity }
  'task.integrating': { readonly attemptId: AttemptId }
  'task.done': { readonly evidence: readonly EvidenceRef[] }
  'task.failed': { readonly failure: FailureReason }
  'task.retry_scheduled': { readonly attemptCount: number; readonly backoffMs: number }
  'task.blocked': { readonly blockage: Blockage }
  'task.unblocked': { readonly note: string }
  'task.skipped': { readonly reason: string }
  'task.cancelled': { readonly reason?: string }
  'task.reopened': { readonly reason: string }

  'attempt.started': { readonly attemptNumber: number; readonly workspace: WorkspaceRef }
  'attempt.finished': { readonly result: AttemptResult; readonly durationMs: number }
  'attempt.observed': { readonly observation: Observation }
  'attempt.cancelled': { readonly reason: string }

  'gate.started': { readonly gateId: GateId; readonly scope: 'task' | 'mission' }
  'gate.command_finished': { readonly result: CommandResult }
  'gate.finished': { readonly gateExecutionId: string; readonly status: GateStatus }

  'review.requested': { readonly policy: ReviewPolicy; readonly reviewer: AgentIdentity }
  'review.finished': { readonly verdict: ReviewVerdict; readonly findings: number }
  'review.policy_downgraded': {
    readonly from: ReviewPolicy
    readonly to: ReviewPolicy
    readonly reason: string
  }
  'review.escalated': { readonly rationale: string }

  'workspace.acquired': { readonly workspace: WorkspaceRef }
  'workspace.released': { readonly disposition: 'keep' | 'discard' }
  'workspace.integrated': { readonly status: IntegrationStatus; readonly commit?: string }
  'workspace.conflict': { readonly paths: readonly string[] }

  'policy.invalid_transition': {
    readonly machine: 'task' | 'run'
    readonly from: string | null
    readonly to: string
    readonly trigger: string
    readonly reason: string
  }
  'policy.scope_violation': {
    readonly outOfScopePaths: readonly string[]
    readonly occurrence: number
  }
  'policy.capacity_exhausted': { readonly providerId: ProviderId }

  'human.mission_approved': { readonly actor: string; readonly at: Date }
  'human.task_unblocked': { readonly actor: string; readonly note: string }
  'human.task_skipped': { readonly actor: string; readonly reason: string }
  'human.task_reopened': { readonly actor: string; readonly reason: string }
  'human.run_cancelled': { readonly actor: string; readonly reason?: string }
  'human.note_added': { readonly actor: string; readonly note: string }
}

export type EventType = keyof EventPayloadMap & string

export interface EventEnvelope {
  readonly seq: number
  readonly runId: RunId
  readonly ts: Date
  readonly actor: Actor
  readonly taskId?: TaskId
  readonly attemptId?: AttemptId
}

export type DomainEvent = {
  [K in EventType]: EventEnvelope & { readonly type: K; readonly payload: EventPayloadMap[K] }
}[EventType]

/** `Event` no vocabulario do DOMAIN-MODEL 3.10. */
export type { DomainEvent as Event }

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/** O `seq` e atribuido pelo EventStore no append: quem emite nao o conhece. */
export type DomainEventInput = DistributiveOmit<DomainEvent, 'seq'>

export const EVENT_TYPES = [
  'run.created',
  'run.approved',
  'run.started',
  'run.paused',
  'run.resumed',
  'run.blocked',
  'run.verifying',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'task.created',
  'task.ready',
  'task.dispatched',
  'task.verifying',
  'task.review_requested',
  'task.integrating',
  'task.done',
  'task.failed',
  'task.retry_scheduled',
  'task.blocked',
  'task.unblocked',
  'task.skipped',
  'task.cancelled',
  'task.reopened',
  'attempt.started',
  'attempt.finished',
  'attempt.observed',
  'attempt.cancelled',
  'gate.started',
  'gate.command_finished',
  'gate.finished',
  'review.requested',
  'review.finished',
  'review.policy_downgraded',
  'review.escalated',
  'workspace.acquired',
  'workspace.released',
  'workspace.integrated',
  'workspace.conflict',
  'policy.invalid_transition',
  'policy.scope_violation',
  'policy.capacity_exhausted',
  'human.mission_approved',
  'human.task_unblocked',
  'human.task_skipped',
  'human.task_reopened',
  'human.run_cancelled',
  'human.note_added',
] as const satisfies readonly EventType[]

export function eventNamespace(type: EventType): EventNamespace {
  const prefix = type.slice(0, type.indexOf('.'))
  return prefix as EventNamespace
}

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value)
}
