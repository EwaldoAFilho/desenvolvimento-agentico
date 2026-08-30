import type {
  AgentIdentity,
  AgentProfile,
  AgentProfileId,
  AttemptId,
  CapacitySnapshot,
  DispatchReason,
  FrozenGraph,
  MissionDefaults,
  PathScope,
  ProviderId,
  ReviewPolicy,
  ReviewPolicyOutcome,
  Risk,
  RunPolicies,
  RunStatus,
  TaskId,
  TaskRun,
  TaskSpec,
} from '@agentic/domain'

/**
 * Escopo de escrita reservado por uma tentativa em voo. O scheduler nunca adquire lock:
 * ele recebe os que existem e recusa quem colide (I2).
 */
export interface ActiveLock {
  readonly taskId: TaskId
  readonly paths: readonly PathScope[]
}

/**
 * Tentativa em `VERIFYING` que passou no gate e aguarda revisor. Quem decide que a revisao
 * e exigida e a maquina de estados; aqui ela ja chega pendente.
 */
export interface PendingReview {
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  /** Identidade que executou a tentativa: base de `reviewer != executor` (I3). */
  readonly executor: AgentIdentity
}

/** Niveis de resolucao de `ReviewPolicy` que nao vem da task (DOMAIN-MODEL 3.6.1). */
export interface ProjectReviewPolicy {
  readonly byRisk?: Readonly<Partial<Record<Risk, ReviewPolicy>>>
  readonly default?: ReviewPolicy
}

/**
 * Retrato completo do que o scheduler precisa. Nada e consultado: sem I/O, sem registry,
 * sem relogio proprio (ARCHITECTURE 3.2).
 *
 * Contrato de contagem de `capacity`: `global.active` conta todo trabalho de agente em voo
 * — executores **e** revisores. Despachar uma revisao consome vaga global, vaga de revisor
 * e vaga do provider escolhido; capacidade de provider e compartilhada entre os dois papeis
 * (DOMAIN-MODEL 4.6).
 */
export interface SchedulerInput {
  /** Grafo congelado no Run: a ordem canonica vem daqui, nunca de `tasks`. */
  readonly graph: FrozenGraph
  readonly tasks: readonly TaskRun[]
  readonly specs: ReadonlyMap<TaskId, TaskSpec>
  readonly runStatus: RunStatus
  readonly policies: RunPolicies
  readonly capacity: CapacitySnapshot
  readonly locks: readonly ActiveLock[]
  /** Perfis aptos a executar. Provider ausente de `capacity.byProvider` nao e despachavel. */
  readonly executorCandidates: readonly AgentProfile[]
  readonly reviewCandidates: readonly AgentIdentity[]
  readonly pendingReviews: readonly PendingReview[]
  readonly missionDefaults?: MissionDefaults
  readonly projectReviewPolicy?: ProjectReviewPolicy
  /** Reservado para politica temporal (backoff). Nenhum criterio do MVP le o relogio. */
  readonly now: Date
}

/** Unico motivo de bloqueio decidido pelo scheduler hoje (I10, transicao 12b). */
export type SchedulerBlockReason = 'CROSS_PROVIDER_UNAVAILABLE'

export interface DispatchExecutorDecision {
  readonly kind: 'dispatch-executor'
  readonly taskId: TaskId
  readonly providerId: ProviderId
  readonly profileId: AgentProfileId
  readonly reason: DispatchReason
}

export interface DispatchReviewerDecision {
  readonly kind: 'dispatch-reviewer'
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly reviewer: AgentIdentity
  readonly policy: ReviewPolicy
  readonly policyOutcome: ReviewPolicyOutcome
}

export interface BlockTaskDecision {
  readonly kind: 'block-task'
  readonly taskId: TaskId
  readonly reason: SchedulerBlockReason
}

/** Decisao, nao efeito: o orquestrador e quem adquire lock, workspace e despacha. */
export type SchedulerDecision =
  | DispatchExecutorDecision
  | DispatchReviewerDecision
  | BlockTaskDecision
