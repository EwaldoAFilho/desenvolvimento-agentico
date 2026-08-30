import type { TaskId } from '@agentic/domain'
import {
  type RetryTaskCommand,
  RetryTaskCommandSchema,
  type SkipTaskCommand,
  SkipTaskCommandSchema,
  type UnblockTaskCommand,
  UnblockTaskCommandSchema,
} from '@agentic/schemas'
import { CommandRefusedError } from '../engine/index.js'

export interface HumanRunCommand {
  readonly actor: string
  readonly reason?: string
}

/**
 * O que um caso de uso de comando precisa do orquestrador. Nenhum deles escreve estado por
 * fora: toda mutacao continua serializada no unico escritor (I7).
 */
export interface OrchestratorCommands {
  pause(command: HumanRunCommand): Promise<void>
  resume(command: HumanRunCommand): Promise<void>
  cancel(command: HumanRunCommand): Promise<void>
  cancelTask(command: { taskId: TaskId; actor: string; reason?: string }): Promise<void>
  unblockTask(command: { taskId: TaskId; actor: string; note: string }): Promise<void>
  retryTask(command: { taskId: TaskId; actor: string; reason?: string }): Promise<void>
  skipTask(command: { taskId: TaskId; actor: string; reason: string }): Promise<void>
  tick(): Promise<void>
}

const DEFAULT_ACTOR = 'humano'

function refuse(detail: string, issues: readonly { readonly message: string }[]): never {
  throw new CommandRefusedError(`${detail}: ${issues.map((issue) => issue.message).join('; ')}`)
}

/** PauseRun: nada novo e despachado; a tentativa em voo termina. */
export function pauseRun(
  orchestrator: OrchestratorCommands,
  command: HumanRunCommand,
): Promise<void> {
  return orchestrator.pause(command)
}

/** ResumeRun: volta a despachar e pede um tick imediato. */
export async function resumeRun(
  orchestrator: OrchestratorCommands,
  command: HumanRunCommand,
): Promise<void> {
  await orchestrator.resume(command)
  await orchestrator.tick()
}

/** StopRun: cancela o run inteiro, encerrando as tentativas em voo no provider. */
export function stopRun(
  orchestrator: OrchestratorCommands,
  command: HumanRunCommand,
): Promise<void> {
  return orchestrator.cancel(command)
}

/** UnblockTask: nota obrigatoria — atrito deliberado sobre decisao humana (DASHBOARD 7). */
export async function unblockTask(
  orchestrator: OrchestratorCommands,
  command: UnblockTaskCommand,
): Promise<void> {
  const parsed = UnblockTaskCommandSchema.safeParse(command)
  if (!parsed.success) refuse('unblock recusado', parsed.error.issues)
  await orchestrator.unblockTask({
    taskId: parsed.data.taskId as TaskId,
    actor: parsed.data.actor ?? DEFAULT_ACTOR,
    note: parsed.data.note,
  })
}

/** RetryTask: reabre a task com registro do autor e concede a tentativa autorizada. */
export async function retryTask(
  orchestrator: OrchestratorCommands,
  command: RetryTaskCommand,
): Promise<void> {
  const parsed = RetryTaskCommandSchema.safeParse(command)
  if (!parsed.success) refuse('retry recusado', parsed.error.issues)
  await orchestrator.retryTask({
    taskId: parsed.data.taskId as TaskId,
    actor: parsed.data.actor ?? DEFAULT_ACTOR,
    reason: parsed.data.reason ?? parsed.data.note,
  })
}

/** SkipTask: motivo obrigatorio — dispensar trabalho fica registrado. */
export async function skipTask(
  orchestrator: OrchestratorCommands,
  command: SkipTaskCommand,
): Promise<void> {
  const parsed = SkipTaskCommandSchema.safeParse(command)
  if (!parsed.success) refuse('skip recusado', parsed.error.issues)
  await orchestrator.skipTask({
    taskId: parsed.data.taskId as TaskId,
    actor: parsed.data.actor ?? DEFAULT_ACTOR,
    reason: parsed.data.reason,
  })
}

/** CancelTask: transicao 21 sobre uma task; o run deixa de ser completavel. */
export function cancelTask(
  orchestrator: OrchestratorCommands,
  command: { readonly taskId: string; readonly actor?: string; readonly reason?: string },
): Promise<void> {
  return orchestrator.cancelTask({
    taskId: command.taskId as TaskId,
    actor: command.actor ?? DEFAULT_ACTOR,
    reason: command.reason,
  })
}
