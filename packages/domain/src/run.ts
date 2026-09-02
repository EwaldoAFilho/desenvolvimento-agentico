import type { GateId, MissionId, RunId, TaskId } from './ids.js'
import type { Dependency, TaskSpec } from './mission.js'

export const RUN_STATUSES = [
  'DRAFT',
  'APPROVED',
  'RUNNING',
  'PAUSED',
  'BLOCKED',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const TERMINAL_RUN_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const

/**
 * Estados em que um run PRECISA de um dono operacional para sair do lugar (I13).
 *
 * Nao e "todo estado nao terminal". `DRAFT` e `APPROVED` esperam ato humano registrado —
 * aprovar (R2) e dar START MISSION (R3) — e dar dono a eles seria o control plane decidindo
 * por conta propria algo que o produto exige de uma pessoa. Os quatro daqui sao diferentes:
 * cada um tem trabalho que so o loop do orquestrador faz. `RUNNING` despacha e colhe;
 * `PAUSED` nao despacha executor (`select.ts`), mas ainda precisa fechar a tentativa que
 * ficou orfa; `BLOCKED` pode voltar a `RUNNING` sozinho quando o impedimento sai (R7);
 * `VERIFYING` tem o mission gate para executar.
 */
export const RECOVERABLE_ACTIVE_RUN_STATUSES = [
  'RUNNING',
  'PAUSED',
  'BLOCKED',
  'VERIFYING',
] as const

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value)
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
}

/** Este run precisa de um Orchestrator vivo com o loop ligado para progredir (I13)? */
export function isRecoverableActiveRunStatus(status: RunStatus): boolean {
  return (RECOVERABLE_ACTIVE_RUN_STATUSES as readonly string[]).includes(status)
}

export interface RunPolicies {
  readonly maxParallelTasks: number
  readonly maxExecutors: number
  readonly maxReviewers: number
  readonly defaultMaxAttempts: number
  readonly attemptTimeoutMs: number
  readonly retryBackoffMs: number
  readonly workspaceMode: 'shared' | 'git-worktree'
  readonly enforceTouches: boolean
  /** Padroes de caminho negados; podem conter glob, por isso sao strings cruas. */
  readonly denyPaths: readonly string[]
}

/**
 * Grafo congelado no inicio do run: alterar o arquivo da missao durante a execucao nao muda
 * o run corrente. O formato completo (`CompiledGraph`) e produzido pelo compilador; o
 * dominio depende apenas desta forma minima.
 */
export interface FrozenGraph {
  readonly specHash: string
  readonly tasks: readonly TaskSpec[]
  readonly edges: readonly Dependency[]
  readonly topologicalOrder: readonly TaskId[]
}

export interface Run {
  readonly id: RunId
  readonly missionId: MissionId
  readonly specHash: string
  readonly graph: FrozenGraph
  readonly status: RunStatus
  readonly policies: RunPolicies
  readonly createdAt: Date
  readonly approvedAt?: Date
  readonly startedAt?: Date
  readonly finishedAt?: Date
  readonly missionGateId?: GateId
  readonly missionGateExecutionId?: string
  readonly integrationBranch?: string
  readonly failureReason?: string
}
