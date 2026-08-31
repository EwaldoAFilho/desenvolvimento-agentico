import type { EventDto, TaskDetail } from '@agentic/schemas'
import type { LogRef } from './activity.js'
import { logRefsOf } from './failure.js'

/**
 * Log do agente na interface. Projecao sobre `attempt.log_persisted` — o evento que o
 * orquestrador emite ao gravar o artefato da tentativa, com `path`, `bytes` e `truncated`.
 *
 * Duas regras que a tela nao pode quebrar:
 *
 * 1. **truncado se diz truncado.** Se o control plane cortou a captura no teto de bytes, a
 *    interface anuncia isso; fingir saida completa e pior do que nao mostrar nada.
 * 2. **saida grande nao trava a interface.** O conteudo do artefato nunca e carregado aqui:
 *    a tela lista caminho, tamanho e truncagem, com teto de linhas renderizadas.
 */
export type AgentLogRole = 'execute' | 'review'

export interface AgentLogArtifact {
  readonly role: AgentLogRole
  readonly path: string
  readonly bytes?: number
  /** `true` quando a captura foi cortada no teto — a saida **nao** esta completa. */
  readonly truncated: boolean
  readonly at: string
  readonly seq: number
  readonly attemptId?: string
}

/** Comando de gate cuja saida persistida foi cortada (`CommandResultDto.truncated`). */
export interface TruncatedOutput {
  readonly command: string
  readonly ref?: string
}

/** Teto de itens desenhados. Log de agente real passa de 4 MB: a lista tem que ter fim. */
export const MAX_LISTED_LOGS = 20

export interface AgentLogView {
  readonly artifacts: readonly AgentLogArtifact[]
  readonly hiddenArtifacts: number
  readonly refs: readonly LogRef[]
  readonly hiddenRefs: number
  /** `true` se qualquer artefato ou saida de comando chegou truncada. */
  readonly truncated: boolean
  readonly truncatedCommands: readonly TruncatedOutput[]
  readonly totalBytes?: number
  /** Frase unica sobre a integridade do que existe. Nunca promete o que nao foi medido. */
  readonly notice: string
  readonly empty: boolean
}

function roleOf(value: unknown): AgentLogRole {
  return value === 'review' ? 'review' : 'execute'
}

/** Artefatos de log anunciados pelos eventos da task, do mais recente para o mais antigo. */
export function agentLogArtifacts(events: readonly EventDto[]): readonly AgentLogArtifact[] {
  const found: AgentLogArtifact[] = []
  for (const event of events) {
    if (event.type !== 'attempt.log_persisted') continue
    const path = event.payload.path
    if (typeof path !== 'string' || path.length === 0) continue
    const bytes = event.payload.bytes
    found.push({
      role: roleOf(event.payload.role),
      path,
      bytes: typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : undefined,
      truncated: event.payload.truncated === true,
      at: event.ts,
      seq: event.seq,
      attemptId: event.attemptId,
    })
  }
  return found.sort((a, b) => b.seq - a.seq)
}

function truncatedCommandsOf(task: TaskDetail): readonly TruncatedOutput[] {
  return task.quality.commandResults
    .filter((result) => result.truncated)
    .map((result) => ({ command: result.command, ref: result.stdoutRef ?? result.stderrRef }))
}

function noticeFor(
  artifacts: readonly AgentLogArtifact[],
  commands: readonly TruncatedOutput[],
): string {
  const cut = artifacts.filter((artifact) => artifact.truncated).length
  if (cut > 0) {
    const plural = cut === 1 ? 'artefato truncado' : 'artefatos truncados'
    return `${cut} ${plural} no teto de captura — a saída NÃO está completa`
  }
  if (commands.length > 0) {
    const plural = commands.length === 1 ? 'comando teve' : 'comandos tiveram'
    return `${commands.length} ${plural} a saída truncada ao persistir — leia o artefato inteiro`
  }
  if (artifacts.length === 0) {
    return 'nenhum log do agente foi persistido para esta task'
  }
  return 'nenhum artefato foi marcado como truncado pelo control plane'
}

/**
 * O que a interface pode dizer sobre o log desta task. `max` existe para o teste provar o
 * teto: nenhuma rajada de eventos vira uma lista infinita na tela.
 */
export function agentLogView(task: TaskDetail, max: number = MAX_LISTED_LOGS): AgentLogView {
  const limit = Math.max(0, max)
  const all = agentLogArtifacts(task.events)
  const commands = truncatedCommandsOf(task)
  // O artefato ja aparece com papel, tamanho e truncagem: repetir o caminho na lista de
  // referencias so gastaria linha.
  const paths = new Set(all.map((artifact) => artifact.path))
  const refs = logRefsOf(task).filter((ref) => !paths.has(ref.ref))
  const bytes = all.reduce<number | undefined>(
    (total, artifact) => (artifact.bytes === undefined ? total : (total ?? 0) + artifact.bytes),
    undefined,
  )
  return {
    artifacts: all.slice(0, limit),
    hiddenArtifacts: Math.max(0, all.length - limit),
    refs: refs.slice(0, limit),
    hiddenRefs: Math.max(0, refs.length - limit),
    truncated: all.some((artifact) => artifact.truncated) || commands.length > 0,
    truncatedCommands: commands,
    totalBytes: bytes,
    notice: noticeFor(all, commands),
    empty: all.length === 0 && refs.length === 0,
  }
}

export const AGENT_LOG_ROLE_LABEL: Record<AgentLogRole, string> = {
  execute: 'executor',
  review: 'revisor',
}
