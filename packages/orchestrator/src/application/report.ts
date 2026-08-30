import type {
  Attempt,
  BlockageKind,
  GateExecution,
  GateStatus,
  MissionId,
  RunId,
  RunStatus,
  TaskId,
  TaskRun,
} from '@agentic/domain'
import { describeGate } from '@agentic/gates'
import { longestPath } from '@agentic/graph'
import type { ApplicationDeps } from './deps.js'
import { MISSION_GATE_ARTIFACT } from './deps.js'
import { graphViewOf } from './graph-view.js'
import { loadRun } from './run-lifecycle.js'
import { attemptDurationMs } from './snapshot.js'

export interface TaskDuration {
  readonly taskId: TaskId
  readonly title: string
  readonly durationMs: number
}

export interface RetriedTask {
  readonly taskId: TaskId
  readonly attempts: number
  readonly failures: readonly string[]
}

export interface ReportBlockage {
  readonly taskId: TaskId
  readonly kind: BlockageKind
  readonly reason: string
  readonly needs: string
}

/** Evidencia citavel: comando exato, cwd e exit code — o humano repete no terminal (P08). */
export interface ReportEvidence {
  readonly scope: 'task' | 'mission'
  readonly taskId?: TaskId
  readonly gateId: string
  readonly status: GateStatus
  readonly command: string
  readonly cwd: string
  readonly exitCode: number | null
  readonly line: string
}

export interface MissionReport {
  readonly runId: RunId
  readonly missionId: MissionId
  readonly status: RunStatus
  readonly tasks: {
    readonly total: number
    readonly done: number
    readonly skipped: number
    readonly cancelled: number
    readonly blocked: number
  }
  readonly attempts: number
  readonly retries: number
  readonly reviewFailures: number
  readonly missionGate?: { readonly gateId: string; readonly status: GateStatus }
  readonly wallTimeMs: number
  /** Caminho critico RECALCULADO com as duracoes observadas, nao com as estimativas. */
  readonly criticalPath: { readonly tasks: readonly TaskId[]; readonly durationMs: number }
  readonly slowestTasks: readonly TaskDuration[]
  readonly retriedTasks: readonly RetriedTask[]
  readonly blockages: readonly ReportBlockage[]
  readonly evidence: readonly ReportEvidence[]
}

function durationOf(task: TaskRun, attempts: readonly Attempt[]): number {
  if (task.startedAt !== undefined && task.finishedAt !== undefined) {
    return Math.max(0, task.finishedAt.getTime() - task.startedAt.getTime())
  }
  return attempts
    .filter((attempt) => attempt.taskRunId.endsWith(`:${task.taskId}`))
    .reduce((sum, attempt) => sum + attemptDurationMs(attempt), 0)
}

function evidenceOf(
  execution: GateExecution,
  scope: 'task' | 'mission',
  taskId?: TaskId,
): ReportEvidence[] {
  return describeGate(execution)
    .filter((repro) => repro.ran)
    .map((repro) => ({
      scope,
      taskId,
      gateId: execution.gateId,
      status: execution.status,
      command: repro.command,
      cwd: repro.cwd,
      exitCode: repro.exitCode,
      line: repro.line,
    }))
}

async function missionGateExecution(
  deps: ApplicationDeps,
  runId: RunId,
): Promise<GateExecution | undefined> {
  try {
    const raw = await deps.artifacts.readText(runId, MISSION_GATE_ARTIFACT)
    const parsed = JSON.parse(raw) as GateExecution
    return { ...parsed, startedAt: new Date(parsed.startedAt) }
  } catch {
    return undefined
  }
}

/**
 * GenerateMissionReport: o que a missao produziu, medido — nunca o que os agentes disseram.
 */
export async function generateMissionReport(
  deps: ApplicationDeps,
  runId: RunId,
): Promise<MissionReport> {
  const run = await loadRun(deps, runId)
  const taskRuns = await deps.store.loadTaskRuns(runId)
  const attempts = await deps.store.loadAttempts(runId)
  const titles = new Map<TaskId, string>(run.graph.tasks.map((task) => [task.id, task.title]))

  const durations = new Map<TaskId, number>()
  for (const task of taskRuns) durations.set(task.taskId, durationOf(task, attempts))

  const view = graphViewOf(run.graph)
  const observed = longestPath(view.graph, (node) => durations.get(node as TaskId) ?? 0)

  const evidence: ReportEvidence[] = []
  for (const attempt of attempts) {
    const taskId = attempt.taskRunId.slice(attempt.taskRunId.indexOf(':') + 1) as TaskId
    for (const execution of attempt.gateExecutions) {
      evidence.push(...evidenceOf(execution, 'task', taskId))
    }
  }
  const missionGate = await missionGateExecution(deps, runId)
  if (missionGate !== undefined) evidence.push(...evidenceOf(missionGate, 'mission'))

  const started = run.startedAt ?? run.createdAt
  const finished = run.finishedAt ?? deps.clock.now()

  return {
    runId: run.id,
    missionId: run.missionId,
    status: run.status,
    tasks: {
      total: taskRuns.length,
      done: taskRuns.filter((task) => task.status === 'DONE').length,
      skipped: taskRuns.filter((task) => task.status === 'SKIPPED').length,
      cancelled: taskRuns.filter((task) => task.status === 'CANCELLED').length,
      blocked: taskRuns.filter((task) => task.status === 'BLOCKED').length,
    },
    attempts: attempts.length,
    retries: taskRuns.reduce((sum, task) => sum + Math.max(0, task.attemptCount - 1), 0),
    reviewFailures: attempts.filter((attempt) => attempt.failureReason?.code === 'REVIEW_FAILED')
      .length,
    missionGate:
      missionGate === undefined
        ? undefined
        : { gateId: missionGate.gateId, status: missionGate.status },
    wallTimeMs: Math.max(0, finished.getTime() - started.getTime()),
    criticalPath: {
      tasks: observed.path.map((node) => node as TaskId),
      durationMs: observed.length,
    },
    slowestTasks: [...durations]
      .map(([taskId, durationMs]) => ({
        taskId,
        title: titles.get(taskId) ?? String(taskId),
        durationMs,
      }))
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 5),
    retriedTasks: taskRuns
      .filter((task) => task.attemptCount > 1)
      .map((task) => ({
        taskId: task.taskId,
        attempts: task.attemptCount,
        failures: attempts
          .filter(
            (attempt) =>
              attempt.taskRunId.endsWith(`:${task.taskId}`) && attempt.failureReason !== undefined,
          )
          .map((attempt) => attempt.failureReason?.code ?? 'AGENT_ERROR'),
      })),
    blockages: taskRuns
      .filter((task) => task.blockage !== undefined && task.status === 'BLOCKED')
      .map((task) => ({
        taskId: task.taskId,
        kind: task.blockage?.kind ?? 'EXTERNAL',
        reason: task.blockage?.reason ?? '',
        needs: task.blockage?.needs ?? '',
      })),
    evidence,
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** O mesmo relatorio em Markdown: e o arquivo versionado em `docs/missions/` (P13). */
export function renderMissionReport(report: MissionReport): string {
  const lines: string[] = [
    `# Relatorio da missao ${report.missionId}`,
    '',
    `- run: \`${report.runId}\``,
    `- resultado: **${report.status}**`,
    `- tasks concluidas: ${report.tasks.done}/${report.tasks.total}` +
      ` (puladas ${report.tasks.skipped}, canceladas ${report.tasks.cancelled}, bloqueadas ${report.tasks.blocked})`,
    `- tentativas: ${report.attempts} · retries: ${report.retries} · reprovacoes de review: ${report.reviewFailures}`,
    `- mission gate: ${report.missionGate === undefined ? 'nao declarado' : `${report.missionGate.gateId} ${report.missionGate.status}`}`,
    `- wall time: ${seconds(report.wallTimeMs)}`,
    '',
    '## Caminho critico real',
    '',
    report.criticalPath.tasks.length === 0
      ? '- (sem caminho observado)'
      : `- ${report.criticalPath.tasks.join(' -> ')} (${seconds(report.criticalPath.durationMs)})`,
    '',
    '## Tasks mais demoradas',
    '',
  ]
  for (const task of report.slowestTasks) {
    lines.push(`- ${task.taskId} ${task.title}: ${seconds(task.durationMs)}`)
  }
  lines.push('', '## Tasks com retry', '')
  if (report.retriedTasks.length === 0) lines.push('- nenhuma')
  for (const task of report.retriedTasks) {
    lines.push(`- ${task.taskId}: ${task.attempts} tentativas (${task.failures.join(', ') || '-'})`)
  }
  lines.push('', '## Bloqueios', '')
  if (report.blockages.length === 0) lines.push('- nenhum')
  for (const blockage of report.blockages) {
    lines.push(
      `- ${blockage.taskId} [${blockage.kind}] ${blockage.reason} — precisa: ${blockage.needs}`,
    )
  }
  lines.push('', '## Evidencia citavel', '')
  if (report.evidence.length === 0) lines.push('- nenhuma execucao de gate registrada')
  for (const item of report.evidence) {
    const owner = item.taskId === undefined ? 'mission' : item.taskId
    lines.push(`- ${owner} · ${item.gateId} · exit ${item.exitCode ?? 'sem codigo'}`)
    lines.push(`  \`\`\`sh`)
    lines.push(`  ${item.line}`)
    lines.push(`  \`\`\``)
  }
  return `${lines.join('\n')}\n`
}
