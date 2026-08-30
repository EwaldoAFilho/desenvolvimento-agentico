import { toEventDto } from '@agentic/orchestrator'
import type { EventDto } from '@agentic/schemas'
import { loadProjectContext } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { createOutput } from '../output.js'
import { resolveRunId, withPlane } from '../plane.js'
import { type CommandResult, ok } from '../result.js'

export interface EventsTailArgs {
  readonly runId?: string
  readonly since?: number
  readonly limit?: number
  readonly follow?: boolean
  readonly project?: string
  readonly json?: boolean
}

export function renderEvent(event: EventDto): string {
  const task = event.taskId === undefined ? '' : ` ${event.taskId}`
  const actor =
    event.actor.id === undefined ? event.actor.kind : `${event.actor.kind}:${event.actor.id}`
  return `${String(event.seq).padStart(5, ' ')}  ${event.ts}  ${event.type}${task}  [${actor}]`
}

/**
 * `events tail`: o log append-only do run. `--since` e EXCLUSIVO — reconecta sem lacuna e
 * sem duplicata, a mesma semantica do SSE (ARCHITECTURE 6.3).
 */
export async function eventsTailCommand(
  args: EventsTailArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const context = await loadProjectContext(deps, args)
  return withPlane(deps, context, async (plane) => {
    const runId = await resolveRunId(plane, args.runId)
    const events = await plane.persistence.events.list(runId, {
      ...(args.since === undefined ? {} : { afterSeq: args.since }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    })
    const dtos = events.map(toEventDto)
    for (const event of dtos) out.line(renderEvent(event))
    if (dtos.length === 0) out.line('(nenhum evento)')

    if (args.follow === true) {
      let cursor = dtos.at(-1)?.seq ?? args.since ?? 0
      for await (const event of plane.persistence.events.subscribe(runId, cursor)) {
        const dto = toEventDto(event)
        cursor = dto.seq
        if (args.json === true) deps.stdout(`${JSON.stringify(dto)}\n`)
        else out.line(renderEvent(dto))
      }
    }
    return ok('events tail', dtos)
  })
}
