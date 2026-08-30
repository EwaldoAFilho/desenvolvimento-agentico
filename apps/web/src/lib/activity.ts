import type { EventDto } from '@agentic/schemas'

/**
 * Atividade ao vivo: a prova de que o agente **nao** esta congelado. Derivada dos eventos
 * do run — nunca dos `claims` do agente, que sao informacao operacional e nao decidem nada
 * (CLAUDE.md, invariante final). Se o control plane nao mediu, aqui nao aparece.
 */
export type ActivityKind =
  | 'workspace-ready'
  | 'agent-started'
  | 'process-active'
  | 'gate-started'
  | 'gate-progress'
  | 'gate-finished'
  | 'review-started'
  | 'review-finished'
  | 'integrating'
  | 'attempt-finished'
  | 'settled'

export interface ActivityStep {
  readonly kind: ActivityKind
  readonly label: string
  readonly at: string
  readonly seq: number
  /** O evento medido que originou o passo — a rastreabilidade e o ponto. */
  readonly source: EventDto['type']
  readonly attemptId?: string
}

interface Mapping {
  readonly kind: ActivityKind
  readonly label: string
}

const BY_EVENT: Partial<Record<EventDto['type'], Mapping>> = {
  'workspace.acquired': { kind: 'workspace-ready', label: 'worktree preparada' },
  'attempt.started': { kind: 'agent-started', label: 'agente iniciado' },
  'task.dispatched': { kind: 'agent-started', label: 'agente despachado' },
  'attempt.observed': { kind: 'process-active', label: 'processo ativo — diff observado' },
  'gate.started': { kind: 'gate-started', label: 'gate iniciado' },
  'gate.command_finished': { kind: 'gate-progress', label: 'comando de gate concluído' },
  'gate.finished': { kind: 'gate-finished', label: 'gate concluído' },
  'task.review_requested': { kind: 'review-started', label: 'revisão iniciada' },
  'review.requested': { kind: 'review-started', label: 'revisão iniciada' },
  'review.finished': { kind: 'review-finished', label: 'revisão concluída' },
  'task.integrating': { kind: 'integrating', label: 'integração iniciada' },
  'attempt.finished': { kind: 'attempt-finished', label: 'tentativa encerrada' },
  'task.done': { kind: 'settled', label: 'task concluída' },
  'task.failed': { kind: 'settled', label: 'task falhou' },
  'task.blocked': { kind: 'settled', label: 'task bloqueada' },
  'task.cancelled': { kind: 'settled', label: 'task cancelada' },
  'task.skipped': { kind: 'settled', label: 'task dispensada' },
}

function detailOf(event: EventDto): string {
  if (event.type === 'gate.finished') {
    const status = event.payload.status
    return typeof status === 'string' ? ` (${status})` : ''
  }
  if (event.type === 'review.finished') {
    const verdict = event.payload.verdict
    return typeof verdict === 'string' ? ` (${verdict})` : ''
  }
  if (event.type === 'attempt.started') {
    const number = event.payload.attemptNumber
    return typeof number === 'number' ? ` (tentativa ${number})` : ''
  }
  if (event.type === 'attempt.finished') {
    const result = event.payload.result
    return typeof result === 'string' ? ` (${result})` : ''
  }
  return ''
}

/** Linha do tempo em ordem de `seq` — a ordem do event log, nao a de chegada na aba. */
export function activityTimeline(events: readonly EventDto[]): readonly ActivityStep[] {
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .flatMap((event) => {
      const mapping = BY_EVENT[event.type]
      if (mapping === undefined) return []
      return [
        {
          kind: mapping.kind,
          label: `${mapping.label}${detailOf(event)}`,
          at: event.ts,
          seq: event.seq,
          source: event.type,
          attemptId: event.attemptId,
        },
      ]
    })
}

const SETTLED: ReadonlySet<ActivityKind> = new Set<ActivityKind>(['settled', 'attempt-finished'])

export interface ActivityPulse {
  readonly last?: ActivityStep
  /** Ha quanto tempo o control plane mediu qualquer sinal desta task. */
  readonly sinceMs?: number
  /** `true` enquanto a task tem tentativa em curso e nenhum evento a encerrou. */
  readonly live: boolean
  readonly steps: readonly ActivityStep[]
}

export function activityPulse(events: readonly EventDto[], now: number): ActivityPulse {
  const steps = activityTimeline(events)
  const last = steps[steps.length - 1]
  if (last === undefined) return { live: false, steps }
  const at = Date.parse(last.at)
  const sinceMs = Number.isNaN(at) ? undefined : Math.max(0, now - at)
  return { last, sinceMs, live: !SETTLED.has(last.kind), steps }
}

export interface LogRef {
  readonly label: string
  readonly ref: string
  /** De onde veio a referencia: comando de gate, evidencia ou observacao do diff. */
  readonly origin: 'gate' | 'evidence' | 'observation'
}

const REF_KEYS = [
  'stdoutRef',
  'stderrRef',
  'logRef',
  'logsRef',
  'agentLogRef',
  'transcriptRef',
] as const

/**
 * Referencias de saida persistida citadas pelo detalhe. O smoke com agente real mostrou o
 * custo de nao ter a saida do agente em lugar nenhum: quando a referencia existe, a UI
 * precisa oferecer o caminho; quando nao existe, precisa dizer que nao existe.
 */
export function logRefsFromEvents(events: readonly EventDto[]): readonly LogRef[] {
  const found: LogRef[] = []
  const seen = new Set<string>()
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    for (const key of REF_KEYS) {
      const value = event.payload[key]
      if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
      seen.add(value)
      found.push({ label: `${event.type} · ${key}`, ref: value, origin: 'observation' })
    }
    const observation = event.payload.observation
    if (typeof observation === 'object' && observation !== null) {
      const diffRef = (observation as { diffRef?: unknown }).diffRef
      if (typeof diffRef === 'string' && diffRef.length > 0 && !seen.has(diffRef)) {
        seen.add(diffRef)
        found.push({ label: 'diff observado', ref: diffRef, origin: 'observation' })
      }
    }
  }
  return found
}
