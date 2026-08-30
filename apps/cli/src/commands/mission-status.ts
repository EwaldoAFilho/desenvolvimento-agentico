import type { RunSnapshot } from '@agentic/schemas'
import { loadProjectContext } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { createOutput, duration, type Output, table, tristate } from '../output.js'
import { resolveRunId, withPlane } from '../plane.js'
import { type CommandResult, ok } from '../result.js'

export interface RunTargetArgs {
  readonly runId?: string
  readonly project?: string
  readonly json?: boolean
}

export function renderSnapshot(out: Output, snapshot: RunSnapshot): void {
  const run = snapshot.run
  out.line(`run ${run.id} · ${run.missionId} · ${run.status}`)
  out.line(
    `criado ${run.timestamps.createdAt}` +
      (run.timestamps.startedAt === undefined ? '' : ` · iniciado ${run.timestamps.startedAt}`) +
      (run.timestamps.finishedAt === undefined ? '' : ` · encerrado ${run.timestamps.finishedAt}`),
  )
  out.line(
    `politicas: paralelismo ${run.policies.maxParallelTasks} · executores ${run.policies.maxExecutors}` +
      ` · revisores ${run.policies.maxReviewers} · workspace ${run.policies.workspaceMode}`,
  )
  if (run.integrationBranch !== undefined) out.line(`branch da missao: ${run.integrationBranch}`)
  out.line()

  const counters = Object.entries(snapshot.counters)
    .filter(([, total]) => total > 0)
    .map(([status, total]) => `${status} ${total}`)
  out.line(`tasks (${snapshot.tasks.length}): ${counters.join(' · ')}`)
  out.line()
  out.lines(
    table(
      ['TASK', 'STATUS', 'TENT.', 'DURACAO'],
      snapshot.tasks.map((task) => [
        task.id,
        task.status,
        String(task.attemptCount),
        duration(task.durationMs),
      ]),
    ).map((line) => `  ${line}`),
  )
  out.line()
  out.line(`waves: ${snapshot.graph.waves.map((wave) => wave.join('+')).join(' -> ')}`)
  out.line(`caminho critico: ${snapshot.graph.criticalPath.join(' -> ')}`)
  out.line()
  out.lines(
    table(
      ['FORNECEDOR', 'INSTALADO', 'PRONTO', 'EM USO', 'CAPACIDADE'],
      snapshot.providers.map((provider) => [
        provider.providerId,
        tristate(provider.installed),
        tristate(provider.ready),
        String(provider.running),
        provider.capacity === null ? 'sem teto' : String(provider.capacity),
      ]),
    ).map((line) => `  ${line}`),
  )
  out.line()
  out.line(
    `metricas: wall ${duration(snapshot.metrics.wallTimeMs)} · tentativas ${snapshot.metrics.attempts}` +
      ` · retries ${snapshot.metrics.retries} · paralelismo ${snapshot.metrics.parallelismRatio.toFixed(2)}`,
  )
}

/** `mission status`: leitura pura. Funciona com o run parado, sem daemon (ARCHITECTURE 4). */
export async function missionStatusCommand(
  args: RunTargetArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const context = await loadProjectContext(deps, args)
  return withPlane(deps, context, async (plane) => {
    const runId = await resolveRunId(plane, args.runId)
    const snapshot = await plane.getRunSnapshot(runId)
    renderSnapshot(out, snapshot)
    return ok('mission status', snapshot)
  })
}
