import type { RunId } from '@agentic/domain'
import {
  RetryTaskCommandSchema,
  SkipTaskCommandSchema,
  UnblockTaskCommandSchema,
} from '@agentic/schemas'
import { loadProjectContext, type ProjectContext } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { createOutput } from '../output.js'
import { parseRunId, parseTaskId, requireLink, resolveRunId, withPlane } from '../plane.js'
import { type CommandResult, ok, usageError } from '../result.js'

export interface RunCommandArgs {
  readonly runId?: string
  readonly actor?: string
  readonly reason?: string
  readonly project?: string
  readonly json?: boolean
  readonly port?: number
}

export interface TaskCommandArgs extends RunCommandArgs {
  readonly taskId: string
  readonly note?: string
}

export interface MutationData {
  readonly runId: string
  readonly taskId?: string
  readonly command: string
  readonly actor: string
  readonly deliveredTo: string
}

function actorOf(args: RunCommandArgs, deps: CommandDeps): string {
  const declared = args.actor?.trim()
  if (declared !== undefined && declared.length > 0) return declared
  const user = deps.env.USER ?? deps.env.USERNAME
  return user === undefined || user.length === 0 ? 'humano' : user
}

async function targetRun(deps: CommandDeps, context: ProjectContext, raw?: string): Promise<RunId> {
  if (raw !== undefined) return parseRunId(raw)
  return withPlane(deps, context, (plane) => resolveRunId(plane))
}

interface IssueLike {
  readonly message: string
  readonly path: readonly PropertyKey[]
}

function issuesOf(issues: readonly IssueLike[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '(raiz)'}: ${issue.message}`)
    .join('; ')
}

/**
 * Toda mutacao vai pelo control plane no ar (ARCHITECTURE 4): a CLI traduz a intencao em
 * comando de contrato e entrega. Nao existe escrita no banco por fora do orquestrador (I7).
 */
async function deliver(
  deps: CommandDeps,
  args: RunCommandArgs,
  command: string,
  path: (runId: RunId) => string,
  body: Record<string, unknown>,
  taskId?: string,
): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const context = await loadProjectContext(deps, args)
  const runId = await targetRun(deps, context, args.runId)
  const link = await requireLink(deps, context, args.port)
  await link.send({ method: 'POST', path: path(runId), body })

  const target = taskId === undefined ? `run ${runId}` : `task ${taskId} do run ${runId}`
  out.line(`${command} enviado para ${target} via ${link.endpoint}`)
  const data: MutationData = {
    runId,
    ...(taskId === undefined ? {} : { taskId }),
    command,
    actor: String(body.actor ?? ''),
    deliveredTo: link.endpoint,
  }
  return ok(command, data)
}

export async function pauseCommand(
  args: RunCommandArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const actor = actorOf(args, deps)
  return deliver(deps, args, 'mission pause', (runId) => `/api/runs/${runId}/pause`, {
    actor,
    ...(args.reason === undefined ? {} : { reason: args.reason }),
  })
}

export async function resumeCommand(
  args: RunCommandArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const actor = actorOf(args, deps)
  return deliver(deps, args, 'mission resume', (runId) => `/api/runs/${runId}/resume`, {
    actor,
    ...(args.reason === undefined ? {} : { reason: args.reason }),
  })
}

export async function stopCommand(args: RunCommandArgs, deps: CommandDeps): Promise<CommandResult> {
  const actor = actorOf(args, deps)
  return deliver(deps, args, 'mission stop', (runId) => `/api/runs/${runId}/stop`, {
    actor,
    ...(args.reason === undefined ? {} : { reason: args.reason }),
  })
}

export async function taskRetryCommand(
  args: TaskCommandArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const taskId = parseTaskId(args.taskId)
  const parsed = RetryTaskCommandSchema.safeParse({
    taskId,
    actor: actorOf(args, deps),
    ...(args.reason === undefined ? {} : { reason: args.reason }),
  })
  if (!parsed.success)
    throw usageError(`retry recusado: ${issuesOf(parsed.error.issues)}`, 'INVALID_COMMAND')
  return deliver(
    deps,
    args,
    'task retry',
    (runId) => `/api/runs/${runId}/tasks/${taskId}/retry`,
    parsed.data,
    taskId,
  )
}

/** `unblock` EXIGE nota: atrito deliberado sobre decisao humana (DASHBOARD 7). */
export async function taskUnblockCommand(
  args: TaskCommandArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const taskId = parseTaskId(args.taskId)
  const parsed = UnblockTaskCommandSchema.safeParse({
    taskId,
    actor: actorOf(args, deps),
    note: args.note ?? '',
  })
  if (!parsed.success) {
    throw usageError(
      `unblock exige --note com a justificativa: ${issuesOf(parsed.error.issues)}`,
      'MISSING_NOTE',
    )
  }
  return deliver(
    deps,
    args,
    'task unblock',
    (runId) => `/api/runs/${runId}/tasks/${taskId}/unblock`,
    parsed.data,
    taskId,
  )
}

/** `skip` EXIGE motivo: dispensar trabalho fica registrado. */
export async function taskSkipCommand(
  args: TaskCommandArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const taskId = parseTaskId(args.taskId)
  const parsed = SkipTaskCommandSchema.safeParse({
    taskId,
    actor: actorOf(args, deps),
    reason: args.reason ?? '',
  })
  if (!parsed.success) {
    throw usageError(
      `skip exige --reason com o motivo: ${issuesOf(parsed.error.issues)}`,
      'MISSING_REASON',
    )
  }
  return deliver(
    deps,
    args,
    'task skip',
    (runId) => `/api/runs/${runId}/tasks/${taskId}/skip`,
    parsed.data,
    taskId,
  )
}
