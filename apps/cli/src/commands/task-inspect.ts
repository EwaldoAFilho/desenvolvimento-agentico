import type { TaskDetail } from '@agentic/schemas'
import { loadProjectContext } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { createOutput, duration, type Output, table } from '../output.js'
import { parseTaskId, resolveRunId, withPlane } from '../plane.js'
import { type CommandResult, ok } from '../result.js'

export interface TaskInspectArgs {
  readonly taskId: string
  readonly runId?: string
  readonly project?: string
  readonly json?: boolean
}

const NONE = '-'

function renderTaskDetail(out: Output, detail: TaskDetail): void {
  out.line(`${detail.id} ${detail.title} · ${detail.status} · fase ${detail.phase}`)
  out.line(`objetivo: ${detail.objective}`)
  out.line()

  out.line('grafo')
  out.line(
    `  dependencias  ${detail.graph.dependencies.map((dep) => `${dep.id}:${dep.status}`).join(' ') || NONE}`,
  )
  out.line(`  dependentes   ${detail.graph.dependents.join(' ') || NONE}`)
  out.line(`  critico       ${detail.graph.onCriticalPath ? 'sim' : 'nao'}`)
  out.line()

  out.line('escopo')
  out.line(`  touches       ${detail.scope.touches.join(' ') || NONE}`)
  out.line(`  reads         ${detail.scope.reads.join(' ') || NONE}`)
  out.line(`  fora do escopo ${detail.scope.outOfScopePaths.join(' ') || NONE}`)
  out.line()

  out.line('execucao')
  out.line(`  provider      ${detail.execution.provider ?? NONE}`)
  out.line(`  executor      ${detail.execution.executor?.profileId ?? NONE}`)
  out.line(
    `  tentativa     ${detail.execution.attempt === undefined ? NONE : `${detail.execution.attempt.number}/${detail.execution.attempt.max}`}`,
  )
  out.line(`  duracao       ${duration(detail.execution.durationMs)}`)
  out.line()

  out.line('revisao')
  out.line(`  revisor       ${detail.review.reviewer?.profileId ?? NONE}`)
  out.line(`  fornecedor    ${detail.review.reviewerProvider ?? NONE}`)
  out.line(
    `  politica      ${detail.review.policy ?? NONE} ${detail.review.policyOutcome ?? ''}`.trimEnd(),
  )
  out.line(`  veredito      ${detail.review.verdict ?? NONE}`)
  out.line()

  // Isolamento e o que o humano precisa para abrir o editor: `code <worktree>`.
  out.line('isolamento')
  out.line(`  worktree      ${detail.isolation.worktreePath ?? NONE}`)
  out.line(`  branch        ${detail.isolation.branch ?? NONE}`)
  out.line(`  base          ${detail.isolation.baseCommit ?? NONE}`)
  out.line(`  commit        ${detail.isolation.commit ?? NONE}`)
  if (detail.isolation.worktreePath !== undefined) {
    out.line(`  abrir         code ${detail.isolation.worktreePath}`)
  }
  out.line()

  out.line('qualidade')
  out.line(
    `  gate          ${detail.quality.gate ?? NONE} ${detail.quality.gateStatus ?? ''}`.trimEnd(),
  )
  for (const validation of detail.quality.validation) out.line(`  validacao     ${validation}`)
  for (const result of detail.quality.commandResults) {
    out.line(
      `  comando       ${result.command} (exit ${result.exitCode ?? 'sem codigo'}) em ${result.cwd}`,
    )
  }
  out.line()

  out.line('fatos')
  out.line(
    `  diff          ${detail.facts.diffStat.files} arquivos +${detail.facts.diffStat.added} -${detail.facts.diffStat.removed}`,
  )
  for (const evidence of detail.facts.evidence) {
    out.line(`  evidencia     ${evidence.kind} ${evidence.digest}`)
  }
  if (detail.failure !== undefined) {
    out.line()
    out.line(`falha: ${detail.failure.failureCode} ${detail.failure.detail ?? ''}`.trimEnd())
  }
  if (detail.blockage !== undefined) {
    out.line()
    out.line(
      `bloqueio: [${detail.blockage.kind}] ${detail.blockage.reason} — precisa: ${detail.blockage.needs}`,
    )
  }
  if (detail.attempts.length > 0) {
    out.line()
    out.lines(
      table(
        ['TENT.', 'RESULTADO', 'GATE', 'REVIEW', 'BRANCH', 'WORKTREE'],
        detail.attempts.map((attempt) => [
          String(attempt.attemptNumber),
          attempt.result ?? NONE,
          attempt.gateStatus ?? NONE,
          attempt.reviewVerdict ?? NONE,
          attempt.branch ?? NONE,
          attempt.worktreePath ?? NONE,
        ]),
      ).map((line) => `  ${line}`),
    )
  }
}

/** `task inspect`: detalhe completo, com worktree e branch — e o que abre o editor. */
export async function taskInspectCommand(
  args: TaskInspectArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const taskId = parseTaskId(args.taskId)
  const context = await loadProjectContext(deps, args)
  return withPlane(deps, context, async (plane) => {
    const runId = await resolveRunId(plane, args.runId)
    const detail = await plane.getTaskDetail(runId, taskId)
    renderTaskDetail(out, detail)
    return ok('task inspect', detail)
  })
}
