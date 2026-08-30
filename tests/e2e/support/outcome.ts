import type { Attempt, DomainEvent, TaskRun } from '@agentic/domain'
import type { MissionHarness } from './harness.js'

/**
 * Retrato do DESFECHO de um run, sem nada que mude entre execucoes (ids, relogio,
 * duracoes). E o que a prova de determinismo compara: dois runs do mesmo cenario precisam
 * produzir exatamente este objeto.
 *
 * Toda lista e ordenada por task. A ORDEM em que duas tasks concorrentes terminam nao faz
 * parte do desfecho — se fizesse, o teste estaria exigindo que o paralelismo fosse falso.
 */
export interface RunOutcome {
  readonly run: string
  readonly tasks: readonly string[]
  readonly gates: readonly string[]
  readonly reviews: readonly string[]
  readonly evidence: readonly string[]
  readonly events: readonly string[]
  readonly missionGate: string
}

export function taskIdOf(attempt: Attempt): string {
  return attempt.taskRunId.slice(attempt.taskRunId.indexOf(':') + 1)
}

function gatesOf(attempts: readonly Attempt[]): string[] {
  const out: string[] = []
  for (const attempt of attempts) {
    for (const execution of attempt.gateExecutions) {
      const exits = execution.results.map((result) => String(result.exitCode)).join('/')
      out.push(
        `${taskIdOf(attempt)} a${attempt.attemptNumber} ${execution.gateId} ${execution.status} [${exits}]`,
      )
    }
  }
  return out
}

function reviewsOf(attempts: readonly Attempt[]): string[] {
  return attempts
    .filter((attempt) => attempt.review !== undefined)
    .map((attempt) => {
      const review = attempt.review
      return `${taskIdOf(attempt)} a${attempt.attemptNumber} ${review?.verdict} ${review?.policy} ${review?.policyOutcome}`
    })
}

function evidenceOf(events: readonly DomainEvent[]): string[] {
  return events
    .filter((event) => event.type === 'task.done')
    .map((event) => {
      const kinds =
        event.type === 'task.done' ? event.payload.evidence.map((ref) => ref.kind).sort() : []
      return `${event.taskId} ${kinds.join(',')}`
    })
}

/** Sequencia de eventos POR TASK: dentro de uma task a ordem e determinista. */
function eventsPerTask(events: readonly DomainEvent[], tasks: readonly TaskRun[]): string[] {
  return tasks.map((task) => {
    const types = events
      .filter((event) => event.taskId === task.taskId)
      .map((event) => event.type)
      .join('>')
    return `${task.taskId} ${types}`
  })
}

export async function outcomeOf(harness: MissionHarness): Promise<RunOutcome> {
  const run = await harness.run()
  const tasks = await harness.tasks()
  const attempts = await harness.attempts()
  const events = await harness.events()
  const report = await harness.plane.generateMissionReport(harness.runId)
  const ordenado = (values: readonly string[]): string[] => [...values].sort()

  return {
    run: `${run.status} tasks=${report.tasks.done}/${report.tasks.total} tentativas=${report.attempts} retries=${report.retries} reviewFailures=${report.reviewFailures}`,
    tasks: ordenado(tasks.map((task) => `${task.taskId} ${task.status} a${task.attemptCount}`)),
    gates: ordenado(gatesOf(attempts)),
    reviews: ordenado(reviewsOf(attempts)),
    evidence: ordenado(evidenceOf(events)),
    events: ordenado(eventsPerTask(events, tasks)),
    missionGate: `${report.missionGate?.gateId ?? 'ausente'} ${report.missionGate?.status ?? '-'}`,
  }
}

/** Janela observada de uma tentativa, pelos instantes que o control plane GRAVOU. */
export interface AttemptWindow {
  readonly taskId: string
  readonly attemptNumber: number
  readonly start: number
  readonly end: number
}

export function windowOf(attempt: Attempt): AttemptWindow {
  return {
    taskId: taskIdOf(attempt),
    attemptNumber: attempt.attemptNumber,
    start: attempt.startedAt.getTime(),
    end: attempt.finishedAt?.getTime() ?? Number.MAX_SAFE_INTEGER,
  }
}

export function overlaps(left: AttemptWindow, right: AttemptWindow): boolean {
  return left.start < right.end && right.start < left.end
}
