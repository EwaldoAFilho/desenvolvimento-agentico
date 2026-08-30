import type { Run, RunId, TaskId } from '@agentic/domain'
import { isRunId, isTaskId } from '@agentic/domain'
import type { ControlPlane } from '@agentic/orchestrator'
import type { ProjectContext } from './context.js'
import type { CommandDeps } from './deps.js'
import { type ControlPlaneLink, endpointOf } from './link.js'
import { CliError, usageError } from './result.js'

/** Abre o control plane local a partir do projeto ja validado. */
export function openPlane(deps: CommandDeps, context: ProjectContext): ControlPlane {
  return deps.controlPlane({
    project: context.project,
    gatesFile: context.gatesFile,
    repoRoot: context.repoRoot,
    baseDir: context.baseDir,
    registry: deps.registry(context.project),
  })
}

/** Abre, usa e fecha: nenhum comando deixa conexao de banco aberta atras de si. */
export async function withPlane<T>(
  deps: CommandDeps,
  context: ProjectContext,
  work: (plane: ControlPlane) => Promise<T>,
): Promise<T> {
  const plane = openPlane(deps, context)
  try {
    return await work(plane)
  } finally {
    await plane.close().catch(() => undefined)
  }
}

export function parseRunId(raw: string): RunId {
  if (!isRunId(raw)) throw usageError(`runId invalido: ${raw}`, 'INVALID_RUN_ID')
  return raw
}

export function parseTaskId(raw: string): TaskId {
  if (!isTaskId(raw)) throw usageError(`taskId invalido: ${raw}`, 'INVALID_TASK_ID')
  return raw
}

/** Sem `runId` explicito, o run corrente e o mais recente do banco. */
export async function resolveRunId(plane: ControlPlane, raw?: string): Promise<RunId> {
  if (raw !== undefined) return parseRunId(raw)
  const rows = plane.persistence.queries.listRuns({ limit: 1 })
  const latest = rows[0]
  if (latest === undefined) {
    throw new CliError('NO_RUN', 'nenhum run neste projeto; use `agentic mission start <arquivo>`')
  }
  return parseRunId(latest.id)
}

/** Run mais recente da missao, opcionalmente amarrado ao `specHash` compilado agora. */
export async function findMissionRun(
  plane: ControlPlane,
  missionId: string,
  specHash?: string,
): Promise<Run | undefined> {
  const rows = plane.persistence.queries.listRuns({ limit: 200 })
  for (const row of rows) {
    if (row.mission_id !== missionId) continue
    if (!isRunId(row.id)) continue
    const run = await plane.persistence.runs.loadRun(row.id)
    if (run === undefined) continue
    if (specHash !== undefined && run.specHash !== specHash) continue
    return run
  }
  return undefined
}

/**
 * Mutacao sobre run exige o control plane no ar (ARCHITECTURE 4). Sem processo, a CLI diz
 * isso — nao escreve no banco por fora do unico escritor (I7).
 */
export async function requireLink(
  deps: CommandDeps,
  context: ProjectContext,
  port?: number,
): Promise<ControlPlaneLink> {
  const endpoint = endpointOf(context.project, port)
  const link = await deps.connect(endpoint)
  if (link === undefined) {
    throw new CliError(
      'NO_CONTROL_PLANE',
      `nenhum control plane respondendo em ${endpoint}: suba um com \`agentic serve\` antes.\n` +
        'comando de mutacao nao escreve no banco por fora do orquestrador (I7).',
    )
  }
  return link
}
