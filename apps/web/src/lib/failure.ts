import type { BlockageDto, TaskDetail } from '@agentic/schemas'
import { type LogRef, logRefsFromEvents } from './activity.js'
import type { TaskStatus } from './status.js'
import type { StalledDependent } from './waiting.js'

/**
 * UX de falha. `FAILED` sozinho nao diz nada acionavel: o painel precisa dizer qual foi o
 * codigo, em que tentativa, com qual fornecedor, se houve violacao de escopo, se o gate
 * chegou a rodar e se ainda ha retry. Tudo projetado do `TaskDetail` — nada e inferido.
 */
export type GateReach = 'not-reached' | 'started' | 'finished'

export type RetryAvailability = 'scheduled' | 'available' | 'exhausted'

export interface ScopeVerdict {
  readonly violated: boolean
  readonly paths: readonly string[]
}

export interface GateReport {
  readonly reach: GateReach
  readonly label: string
  readonly id?: string
  readonly status?: NonNullable<TaskDetail['quality']['gateStatus']>
  readonly commands: number
}

export interface FailureView {
  readonly code: string
  readonly detail?: string
  readonly attempt?: { readonly number: number; readonly max: number }
  readonly provider?: string
  readonly scope: ScopeVerdict
  readonly gate: GateReport
  readonly retry: RetryAvailability
  readonly retryDetail: string
}

function scopeVerdictOf(task: TaskDetail): ScopeVerdict {
  const paths = task.scope.outOfScopePaths
  return { violated: paths.length > 0, paths }
}

/**
 * O gate "chegou a rodar?" e questao de fato: quem responde e o evento `gate.started` do
 * run, com os resultados de comando como confirmacao.
 */
function gateReportOf(task: TaskDetail): GateReport {
  const started = task.events.some((event) => event.type === 'gate.started')
  const finished = task.events.some((event) => event.type === 'gate.finished')
  const commands = task.quality.commandResults.length
  const status = task.quality.gateStatus
  const reach: GateReach =
    finished || status !== undefined
      ? 'finished'
      : started || commands > 0
        ? 'started'
        : 'not-reached'
  const label =
    reach === 'not-reached'
      ? 'não chegou a rodar'
      : reach === 'started'
        ? 'iniciado, sem veredito registrado'
        : `concluído${status === undefined ? '' : ` · ${status}`}`
  return { reach, label, id: task.quality.gate, status, commands }
}

/**
 * Retry: o que o snapshot permite afirmar sem reimplementar a politica do dominio —
 * retry ja agendado, orcamento de tentativas restante, ou orcamento esgotado.
 */
function retryOf(task: TaskDetail): { retry: RetryAvailability; retryDetail: string } {
  const scheduled =
    task.status === 'RETRY' || task.events.some((event) => event.type === 'task.retry_scheduled')
  const attempt = task.execution.attempt
  const exhausted =
    task.blockage?.kind === 'ATTEMPTS_EXHAUSTED' ||
    (attempt !== undefined && attempt.number >= attempt.max)

  if (scheduled && !exhausted) {
    return { retry: 'scheduled', retryDetail: 'nova tentativa já agendada pelo orquestrador' }
  }
  if (exhausted) {
    const budget = attempt === undefined ? '' : ` (${attempt.number} de ${attempt.max})`
    return { retry: 'exhausted', retryDetail: `orçamento de tentativas esgotado${budget}` }
  }
  const remaining = attempt === undefined ? undefined : attempt.max - attempt.number
  return {
    retry: 'available',
    retryDetail:
      remaining === undefined
        ? 'retry disponível'
        : `retry disponível — restam ${remaining} de ${attempt?.max ?? 0} tentativas`,
  }
}

export function failureViewOf(task: TaskDetail): FailureView | undefined {
  if (task.failure === undefined) return undefined
  const { retry, retryDetail } = retryOf(task)
  return {
    code: task.failure.failureCode,
    detail: task.failure.detail,
    attempt: task.execution.attempt,
    provider: task.execution.provider,
    scope: scopeVerdictOf(task),
    gate: gateReportOf(task),
    retry,
    retryDetail,
  }
}

export interface BlockedView {
  readonly kind: BlockageDto['kind']
  readonly reason: string
  readonly needs: string
  readonly raisedBy: string
  readonly raisedAt: string
  readonly resolvedAt?: string
  readonly dependents: readonly StalledDependent[]
}

/**
 * `BLOCKED` responde tres perguntas: por que, o que resolve e quem ficou parado atras.
 * Os dependentes vem de fora (projecao do grafo do snapshot) — o detalhe so os exibe.
 */
export function blockedViewOf(
  task: TaskDetail,
  dependents: readonly StalledDependent[] = [],
): BlockedView | undefined {
  const blockage = task.blockage
  if (blockage === undefined) return undefined
  return {
    kind: blockage.kind,
    reason: blockage.reason,
    needs: blockage.needs,
    raisedBy: blockage.raisedBy,
    raisedAt: blockage.raisedAt,
    resolvedAt: blockage.resolvedAt,
    dependents: dependents.filter((dependent) => dependent.id !== task.id),
  }
}

/** Toda referencia citavel do detalhe: gate, evidencia e o que os eventos registraram. */
export function logRefsOf(task: TaskDetail): readonly LogRef[] {
  const refs: LogRef[] = []
  const seen = new Set<string>()
  const push = (label: string, ref: string | undefined, origin: LogRef['origin']): void => {
    if (ref === undefined || ref.length === 0 || seen.has(ref)) return
    seen.add(ref)
    refs.push({ label, ref, origin })
  }
  for (const result of task.quality.commandResults) {
    push(`${result.command} · stdout`, result.stdoutRef, 'gate')
    push(`${result.command} · stderr`, result.stderrRef, 'gate')
  }
  for (const evidence of task.facts.evidence) {
    push(`${evidence.kind} · ${evidence.sourceId}`, evidence.artifactPath, 'evidence')
  }
  for (const found of logRefsFromEvents(task.events)) {
    push(found.label, found.ref, found.origin)
  }
  return refs
}

/** Estados em que a task acabou parada por falha — o painel muda de tom nesses. */
export function isFailureStatus(status: TaskStatus): boolean {
  return status === 'FAILED' || status === 'RETRY' || status === 'BLOCKED'
}
