import type {
  Actor,
  AttemptId,
  DomainEventInput,
  EventPayloadMap,
  EventType,
  RunId,
  TaskId,
} from '@agentic/domain'

export interface EventContext {
  readonly taskId?: TaskId
  readonly attemptId?: AttemptId
  readonly actor?: Actor
}

/** I7: todo evento do engine sai com ator `orchestrator` — o unico escritor do estado. */
export const ORCHESTRATOR: Actor = { kind: 'orchestrator' }

/**
 * Constroi o evento tipado pelo `type`. O `seq` e do EventStore; quem emite nao o conhece.
 */
export function engineEvent<K extends EventType>(
  runId: RunId,
  ts: Date,
  type: K,
  payload: EventPayloadMap[K],
  context: EventContext = {},
): DomainEventInput {
  const event = {
    runId,
    ts,
    type,
    actor: context.actor ?? ORCHESTRATOR,
    payload,
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
  }
  return event as DomainEventInput
}

export function humanActor(actor: string): Actor {
  return { kind: 'human', id: actor }
}
