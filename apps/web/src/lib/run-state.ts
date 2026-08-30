import {
  BlockageDtoSchema,
  type EventDto,
  type ProviderHealthDto,
  type RunSnapshot,
  type TaskCountersDto,
  type TaskSnapshotDto,
} from '@agentic/schemas'
import { isDependencySatisfied, type RunStatus, TASK_STATUSES, type TaskStatus } from './status.js'

export type EventType = EventDto['type']

/** Quantos eventos o rodape guarda. O log completo mora no servidor, nao na aba do browser. */
export const EVENT_BUFFER = 300

export interface RunState {
  readonly snapshot: RunSnapshot
  /** Ultimo `seq` aplicado: e com ele que a reconexao pede `since=` (ARCHITECTURE 6.3). */
  readonly lastSeq: number
  readonly events: readonly EventDto[]
}

const TASK_STATUS_BY_EVENT: Partial<Record<EventType, TaskStatus>> = {
  'task.created': 'PENDING',
  'task.ready': 'READY',
  'task.dispatched': 'RUNNING',
  'task.verifying': 'VERIFYING',
  'task.review_requested': 'REVIEW',
  'task.integrating': 'INTEGRATING',
  'task.done': 'DONE',
  'task.failed': 'FAILED',
  'task.retry_scheduled': 'RETRY',
  'task.blocked': 'BLOCKED',
  'task.unblocked': 'READY',
  'task.skipped': 'SKIPPED',
  'task.cancelled': 'CANCELLED',
  'task.reopened': 'READY',
}

const RUN_STATUS_BY_EVENT: Partial<Record<EventType, RunStatus>> = {
  'run.created': 'DRAFT',
  'run.approved': 'APPROVED',
  'run.started': 'RUNNING',
  'run.paused': 'PAUSED',
  'run.resumed': 'RUNNING',
  'run.blocked': 'BLOCKED',
  'run.verifying': 'VERIFYING',
  'run.completed': 'COMPLETED',
  'run.failed': 'FAILED',
  'run.cancelled': 'CANCELLED',
}

export function countByStatus(tasks: readonly TaskSnapshotDto[]): TaskCountersDto {
  const counters = Object.fromEntries(
    TASK_STATUSES.map((status) => [status, 0]),
  ) as unknown as Record<TaskStatus, number>
  for (const task of tasks) counters[task.status] += 1
  return counters as TaskCountersDto
}

export function initRunState(snapshot: RunSnapshot, events: readonly EventDto[] = []): RunState {
  const lastSeq = events.reduce((acc, event) => Math.max(acc, event.seq), 0)
  return { snapshot, lastSeq, events: events.slice(-EVENT_BUFFER) }
}

function readNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * `PENDING` -> `READY` quando toda dependencia esta `DONE`/`SKIPPED` (STATE-MACHINES,
 * transicao 2). Isso acende os dependentes no mesmo instante em que a task conclui — o
 * momento mais informativo da tela (DASHBOARD 6). Nao inventa estrutura: le `graph.nodes`,
 * que veio congelado da missao compilada. E idempotente, entao o `task.ready` que o
 * orquestrador emite em seguida apenas confirma.
 */
function lightUpReadyDependents(
  snapshot: RunSnapshot,
  tasks: readonly TaskSnapshotDto[],
  at: string,
): readonly TaskSnapshotDto[] {
  const statusOf = new Map<string, TaskStatus>(tasks.map((task) => [task.id, task.status]))
  let changed = false
  const next = tasks.map((task) => {
    if (task.status !== 'PENDING') return task
    const node = snapshot.graph.nodes.find((candidate) => candidate.id === task.id)
    if (node === undefined || node.dependencies.length === 0) return task
    const satisfied = node.dependencies.every((dep) => {
      const status = statusOf.get(dep)
      return status !== undefined && isDependencySatisfied(status)
    })
    if (!satisfied) return task
    changed = true
    return { ...task, status: 'READY' as TaskStatus, readyAt: task.readyAt ?? at }
  })
  return changed ? next : tasks
}

function applyToTask(task: TaskSnapshotDto, event: EventDto): TaskSnapshotDto {
  let next: TaskSnapshotDto = task
  const status = TASK_STATUS_BY_EVENT[event.type]
  if (status !== undefined) {
    next = { ...next, status }
    if (status === 'READY') next = { ...next, readyAt: next.readyAt ?? event.ts }
    if (status === 'RUNNING') next = { ...next, startedAt: next.startedAt ?? event.ts }
    if (status === 'DONE' || status === 'SKIPPED' || status === 'CANCELLED') {
      next = { ...next, finishedAt: event.ts }
    }
  }
  if (event.type === 'task.blocked') {
    const blockage = BlockageDtoSchema.safeParse(event.payload.blockage)
    if (blockage.success) next = { ...next, blockage: blockage.data }
  }
  if (event.type === 'task.unblocked') next = { ...next, blockage: undefined }
  if (event.type === 'attempt.started') {
    const attemptNumber = readNumber(event.payload, 'attemptNumber')
    next = {
      ...next,
      attemptCount: attemptNumber ?? next.attemptCount + 1,
      currentAttempt: event.attemptId ?? next.currentAttempt,
    }
  }
  const durationMs = readNumber(event.payload, 'durationMs')
  if (durationMs !== undefined && event.type === 'task.done') {
    next = { ...next, durationMs }
  }
  return next
}

/**
 * Aplica um evento sobre o snapshot. Evento com `seq` ja visto e ignorado — e o que faz a
 * reconexao com `since=<ultimo seq>` nao duplicar nada (ARCHITECTURE 6.3).
 */
export function applyEvent(state: RunState, event: EventDto): RunState {
  if (event.seq <= state.lastSeq) return state

  const events = [...state.events, event].slice(-EVENT_BUFFER)
  let tasks: readonly TaskSnapshotDto[] = state.snapshot.tasks
  if (event.taskId !== undefined) {
    const target = event.taskId
    tasks = tasks.map((task) => (task.id === target ? applyToTask(task, event) : task))
  }
  if (event.type === 'task.done' || event.type === 'task.skipped') {
    tasks = lightUpReadyDependents(state.snapshot, tasks, event.ts)
  }

  const runStatus = RUN_STATUS_BY_EVENT[event.type]
  const run =
    runStatus === undefined ? state.snapshot.run : { ...state.snapshot.run, status: runStatus }

  const startedAt = readString(event.payload, 'startedAt')
  const timestamps =
    event.type === 'run.started' && startedAt !== undefined
      ? { ...run.timestamps, startedAt }
      : run.timestamps

  const snapshot: RunSnapshot = {
    ...state.snapshot,
    run: { ...run, timestamps },
    tasks: [...tasks],
    counters: tasks === state.snapshot.tasks ? state.snapshot.counters : countByStatus(tasks),
  }
  return { snapshot, lastSeq: event.seq, events }
}

export function applyEvents(state: RunState, events: readonly EventDto[]): RunState {
  return events.reduce(applyEvent, state)
}

/**
 * `running`/`capacity` chegam pelo mesmo stream, como mensagem propria — nao existe evento de
 * saude de provider no catalogo fechado de `EVENT_TYPES` (DASHBOARD 6).
 */
export function applyProviders(state: RunState, providers: readonly ProviderHealthDto[]): RunState {
  return { ...state, snapshot: { ...state.snapshot, providers: [...providers] } }
}

export function taskById(state: RunState, taskId: string): TaskSnapshotDto | undefined {
  return state.snapshot.tasks.find((task) => task.id === taskId)
}

export function statusMap(state: RunState): ReadonlyMap<string, TaskStatus> {
  return new Map(state.snapshot.tasks.map((task) => [task.id, task.status]))
}
