import type { BlockageDto, RunSnapshot, TaskSnapshotDto } from '@agentic/schemas'
import { isDependencySatisfied, type RunStatus, type TaskStatus } from './status.js'

/**
 * Motivo de espera. **Projecao pura sobre o snapshot** — nao existe estado novo na maquina
 * de estados (STATE-MACHINES): `PENDING` continua `PENDING`. O que muda e a leitura: uma
 * task parada precisa dizer *por que* esta parada, e a resposta ja esta no snapshot
 * (dependencias, bloqueio, capacidade dos providers, status do run).
 */
export type WaitingCause =
  | 'dependencies'
  | 'cross-provider-review'
  | 'provider-capacity'
  | 'run-capacity'
  | 'mission-approval'
  | 'run-not-running'
  | 'retry-backoff'
  | 'attempts-exhausted'
  | 'human-decision'
  | 'dispatch'

export interface DependencyWait {
  readonly id: string
  readonly status: TaskStatus
}

export interface WaitingReason {
  readonly cause: WaitingCause
  /** Texto curto do no: cabe no card e substitui o "so PENDING". */
  readonly summary: string
  /** Texto do painel: o porque completo. */
  readonly detail: string
  /** Ids que precisam concluir, quando a espera e por dependencia. */
  readonly waitingOn: readonly DependencyWait[]
  /** O que resolve, quando alguem precisa agir. */
  readonly needs?: string
}

const WAITING_STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
  'PENDING',
  'READY',
  'RETRY',
  'BLOCKED',
])

export function isWaitingStatus(status: TaskStatus): boolean {
  return WAITING_STATUSES.has(status)
}

/** Estados que ocupam vaga de execucao — servem para medir o paralelismo corrente. */
const PROGRESSING: ReadonlySet<string> = new Set<TaskStatus>([
  'RUNNING',
  'VERIFYING',
  'REVIEW',
  'INTEGRATING',
])

export function unsatisfiedDependencies(
  snapshot: RunSnapshot,
  taskId: string,
): readonly DependencyWait[] {
  const node = snapshot.graph.nodes.find((candidate) => candidate.id === taskId)
  if (node === undefined) return []
  const statusOf = new Map<string, TaskStatus>(snapshot.tasks.map((task) => [task.id, task.status]))
  const pending: DependencyWait[] = []
  for (const dependency of node.dependencies) {
    const status = statusOf.get(dependency)
    if (status === undefined || !isDependencySatisfied(status)) {
      pending.push({ id: dependency, status: status ?? 'PENDING' })
    }
  }
  return pending
}

function listOf(dependencies: readonly DependencyWait[]): string {
  return dependencies.map((dependency) => `${dependency.id} (${dependency.status})`).join(', ')
}

/** `cross-provider-required` sem segundo fornecedor apto vira bloqueio de politica (I10). */
function isCrossProviderBlockage(blockage: BlockageDto): boolean {
  return (
    blockage.reason.toUpperCase().includes('CROSS_PROVIDER') ||
    (blockage.kind === 'POLICY' && blockage.needs.toLowerCase().includes('fornecedor'))
  )
}

function fromBlockage(blockage: BlockageDto): WaitingReason {
  const base = { waitingOn: [], needs: blockage.needs }
  if (isCrossProviderBlockage(blockage)) {
    return {
      ...base,
      cause: 'cross-provider-review',
      summary: 'aguardando revisor de outro fornecedor',
      detail: `revisão exige outro fornecedor e nenhum está apto: ${blockage.reason}`,
    }
  }
  if (blockage.kind === 'ATTEMPTS_EXHAUSTED') {
    return {
      ...base,
      cause: 'attempts-exhausted',
      summary: 'aguardando decisão humana',
      detail: `orçamento de tentativas esgotado: ${blockage.reason}`,
    }
  }
  if (blockage.kind === 'DEPENDENCY') {
    return {
      ...base,
      cause: 'dependencies',
      summary: 'aguardando dependência',
      detail: `bloqueio de dependência: ${blockage.reason}`,
    }
  }
  return {
    ...base,
    cause: 'human-decision',
    summary: 'aguardando decisão humana',
    detail: `bloqueio ${blockage.kind}: ${blockage.reason}`,
  }
}

function providersSaturated(snapshot: RunSnapshot): boolean {
  const measurable = snapshot.providers.filter((provider) => provider.capacity !== null)
  if (measurable.length === 0) return false
  return measurable.every((provider) => provider.running >= (provider.capacity ?? 0))
}

function runCapacityReached(snapshot: RunSnapshot): boolean {
  const busy = snapshot.tasks.filter((task) => PROGRESSING.has(task.status)).length
  return busy >= snapshot.run.policies.maxParallelTasks
}

const RUN_WAIT_SUMMARY: Partial<Record<RunStatus, string>> = {
  DRAFT: 'aguardando aprovação da missão',
  APPROVED: 'aguardando a partida da missão',
  PAUSED: 'aguardando retomada do run',
  BLOCKED: 'aguardando desbloqueio do run',
  COMPLETED: 'run encerrado',
  FAILED: 'run encerrado',
  CANCELLED: 'run encerrado',
}

function fromRunStatus(snapshot: RunSnapshot): WaitingReason | undefined {
  const status = snapshot.run.status
  if (status === 'RUNNING' || status === 'VERIFYING') return undefined
  const summary = RUN_WAIT_SUMMARY[status] ?? `aguardando o run (${status})`
  if (status === 'DRAFT') {
    return {
      cause: 'mission-approval',
      summary,
      detail: 'a missão ainda não foi aprovada — aprovar é ato humano registrado com actor.',
      waitingOn: [],
      needs: 'aprovação da missão',
    }
  }
  return {
    cause: 'run-not-running',
    summary,
    detail: `nada é despachado enquanto o run está ${status}.`,
    waitingOn: [],
    needs: status === 'PAUSED' ? 'resume do run' : undefined,
  }
}

function whileReady(snapshot: RunSnapshot): WaitingReason {
  const byRun = fromRunStatus(snapshot)
  if (byRun !== undefined) return byRun
  if (providersSaturated(snapshot)) {
    const busy = snapshot.providers
      .map((provider) => `${provider.providerId} ${provider.running}/${provider.capacity ?? '—'}`)
      .join(' · ')
    return {
      cause: 'provider-capacity',
      summary: 'aguardando capacidade do fornecedor',
      detail: `nenhum fornecedor tem vaga livre: ${busy}`,
      waitingOn: [],
      needs: 'uma tentativa em andamento terminar, ou mais capacidade configurada',
    }
  }
  if (runCapacityReached(snapshot)) {
    return {
      cause: 'run-capacity',
      summary: 'aguardando vaga de execução',
      detail: `limite de paralelismo do run atingido (maxParallelTasks ${snapshot.run.policies.maxParallelTasks}).`,
      waitingOn: [],
    }
  }
  return {
    cause: 'dispatch',
    summary: 'aguardando despacho',
    detail: 'dependências satisfeitas e capacidade livre: entra no próximo tick do scheduler.',
    waitingOn: [],
  }
}

/**
 * Por que esta task esta parada. Retorna `undefined` para task que nao esta esperando —
 * quem esta `RUNNING` nao espera nada.
 */
export function waitingReasonOf(snapshot: RunSnapshot, taskId: string): WaitingReason | undefined {
  const task = snapshot.tasks.find((candidate) => candidate.id === taskId)
  if (task === undefined || !isWaitingStatus(task.status)) return undefined
  return waitingReasonOfTask(snapshot, task)
}

export function waitingReasonOfTask(
  snapshot: RunSnapshot,
  task: TaskSnapshotDto,
): WaitingReason | undefined {
  if (!isWaitingStatus(task.status)) return undefined

  if (task.blockage !== undefined && task.blockage.resolvedAt === undefined) {
    return fromBlockage(task.blockage)
  }

  const pending = unsatisfiedDependencies(snapshot, task.id)
  if (pending.length > 0) {
    return {
      cause: 'dependencies',
      summary: `aguardando ${pending.map((dependency) => dependency.id).join(', ')}`,
      detail: `dependências não satisfeitas: ${listOf(pending)}`,
      waitingOn: pending,
      needs: 'conclusão das dependências',
    }
  }

  if (task.status === 'RETRY') {
    const backoff = snapshot.run.policies.retryBackoffMs
    return {
      cause: 'retry-backoff',
      summary: 'aguardando nova tentativa',
      detail: `retry agendado — backoff de ${backoff}ms antes da tentativa ${task.attemptCount + 1}.`,
      waitingOn: [],
    }
  }

  return whileReady(snapshot)
}

/** Mapa por task: o canvas precisa do motivo de todas de uma vez, sem N varreduras. */
export function waitingReasons(snapshot: RunSnapshot): ReadonlyMap<string, WaitingReason> {
  const reasons = new Map<string, WaitingReason>()
  for (const task of snapshot.tasks) {
    const reason = waitingReasonOfTask(snapshot, task)
    if (reason !== undefined) reasons.set(task.id, reason)
  }
  return reasons
}

export interface StalledDependent {
  readonly id: string
  readonly status: TaskStatus
  /** `true` quando depende direto; `false` quando so alcança por caminho mais longo. */
  readonly direct: boolean
}

/**
 * Quem ficou parado por causa desta task. Alcancabilidade sobre `graph.edges`, que veio
 * congelado da missao compilada — nao recalcula grafo nem inventa aresta.
 */
export function stalledDependents(
  snapshot: RunSnapshot,
  taskId: string,
): readonly StalledDependent[] {
  const outgoing = new Map<string, string[]>()
  for (const edge of snapshot.graph.edges) {
    const bucket = outgoing.get(edge.from)
    if (bucket === undefined) outgoing.set(edge.from, [edge.to])
    else bucket.push(edge.to)
  }
  const direct = new Set(outgoing.get(taskId) ?? [])
  const statusOf = new Map<string, TaskStatus>(snapshot.tasks.map((task) => [task.id, task.status]))

  const seen = new Set<string>()
  const queue = [...direct]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    for (const next of outgoing.get(current) ?? []) {
      if (!seen.has(next)) queue.push(next)
    }
  }

  return [...seen]
    .filter((id) => {
      const status = statusOf.get(id)
      return status !== undefined && isWaitingStatus(status)
    })
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id, status: statusOf.get(id) ?? 'PENDING', direct: direct.has(id) }))
}
