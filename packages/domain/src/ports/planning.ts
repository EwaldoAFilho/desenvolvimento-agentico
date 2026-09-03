import type { Usage } from '../attempt.js'
import type { GateId, MissionId, ProviderId } from '../ids.js'
import type { MissionSpec } from '../mission.js'

/**
 * Contexto que o planejador recebe: o suficiente para propor um plano que compile, e nada
 * alem disso (P14). Nao ha `taskId`, `attemptId` nem `workspacePath` porque planejar
 * acontece ANTES de existir missao — nao ha task, nao ha tentativa e nao ha worktree para
 * arrendar. I8 e I11 nao se aplicam aqui: eles falam de tentativa (ADR-0016).
 */
export interface PlanningContext {
  /**
   * Raiz que o planejador pode LER. Nao e workspace: nao tem lease, branch nem commit base,
   * e o processo do planejador nao recebe permissao de escrita.
   */
  readonly readRoot: string
  /** Ids ja ocupados, para que a proposta nao colida com missao existente. */
  readonly takenMissionIds: readonly MissionId[]
  /** Gates que o projeto declara. O planejador referencia; nunca inventa gate (P09). */
  readonly availableGates: readonly GateId[]
  /** Restricoes do projeto que a proposta precisa respeitar. */
  readonly constraints: readonly string[]
  /** Caminhos proibidos, para que o plano nao proponha escrever onde nao pode (P04). */
  readonly denyPaths: readonly string[]
}

/** Onde a proposta feriu o contrato. `path` vazio quando o problema e do plano inteiro. */
export interface PlanProblem {
  readonly path: string
  readonly message: string
}

/**
 * Ciclo de reparo: o planejador recebe de volta o que produziu e o motivo da recusa. Sem
 * isto, "tente de novo" e um pedido cego que gasta assinatura repetindo o mesmo erro.
 */
export interface PlanRevision {
  /** 1 na primeira correcao. Nunca excede `MAX_PLAN_REVISIONS`. */
  readonly attempt: number
  /** O que representa a tentativa anterior — saida crua recusada ou plano gerado por nos. */
  readonly previous: string
  readonly problems: readonly PlanProblem[]
}

/**
 * Reparo e deliberadamente curto: duas correcoes e a decisao volta ao humano (P15). Um
 * laco longo esconde do operador que o planejador nao entendeu o pedido.
 */
export const MAX_PLAN_REVISIONS = 2

export interface PlanningRequest {
  /** O pedido do humano, em linguagem natural. */
  readonly prompt: string
  readonly context: PlanningContext
  readonly timeoutMs: number
  /** Ausente na primeira chamada; presente somente no ciclo de reparo. */
  readonly revision?: PlanRevision
}

/**
 * A proposta e DADO, nao arquivo. Quem serializa e grava o `.mission.yaml` e o control
 * plane: os bytes do planejador nunca chegam ao disco, e por isso ele nao consegue declarar
 * `apiVersion` nem escolher onde o artefato mora (ADR-0016).
 *
 * Tambem nao passa por `claims`: o plano e a saida estruturada da chamada, sem o
 * truncamento que o relato de tentativa sofre.
 */
export interface MissionProposal {
  readonly mission: MissionSpec
  /** Relato do planejador sobre as proprias escolhas. Nao decide nada (P05). */
  readonly rationale?: string
}

export const PLANNING_FAILURE_CODES = [
  /** Nao ha planejador utilizavel: ausente, nao instalado ou sem sessao. */
  'PLANNER_UNAVAILABLE',
  'PLANNER_FAILED',
  'PLANNER_TIMEOUT',
  'PLANNER_CANCELLED',
  /** O processo terminou sem produzir nada que se pareca com um plano. */
  'NO_PROPOSAL',
  /** Produziu, mas o contrato recusou. `problems` diz onde. */
  'CONTRACT_REJECTED',
  /** Reproduziu o plano anterior: insistir so gastaria assinatura. */
  'PLAN_UNCHANGED',
  /** Acabaram as correcoes permitidas; a decisao volta ao humano. */
  'REVISIONS_EXHAUSTED',
] as const

export type PlanningFailureCode = (typeof PLANNING_FAILURE_CODES)[number]

/** Falha explicada, nunca plano parcial: meia missao compila e engana. */
export interface PlanningFailure {
  readonly code: PlanningFailureCode
  /** Frase nossa, legivel por humano — nao a saida crua da CLI. */
  readonly message: string
  /** Vazio quando a falha e do processo, nao do plano. */
  readonly problems: readonly PlanProblem[]
  /** O que o planejador produziu, para diagnostico e para o proximo ciclo de reparo. */
  readonly raw?: string
}

export interface PlanningProposed {
  readonly outcome: 'proposed'
  readonly proposal: MissionProposal
  readonly usage?: Usage
  readonly logsRef: string
}

export interface PlanningRefused {
  readonly outcome: 'refused'
  readonly failure: PlanningFailure
  readonly logsRef: string
}

export type PlanningResult = PlanningProposed | PlanningRefused

export interface PlanningCapabilities {
  /**
   * `false` = planejador simulado (fixture, roteiro): nao aciona fornecedor real e nao
   * consome assinatura. A interface precisa do fato para nao apresentar um simulador como
   * planejamento de verdade, e para avisar o consumo antes de acionar o que e real (P17).
   */
  readonly simulated: boolean
  /** Aceita `PlanRevision`? Quem nao aceita nao entra em ciclo de reparo. */
  readonly acceptsRevision: boolean
  readonly reportsUsage: boolean
}

/**
 * Porta de planejamento. Separada de `AgentProvider` porque `Assignment` exige task,
 * tentativa e workspace — os tres inexistem antes da missao nascer (ADR-0016).
 *
 * O planejador le, propoe e termina. Nao aprova, nao executa, nao altera politica, gate nem
 * codigo: a porta nao tem afordancia para nenhuma dessas coisas.
 */
export interface MissionPlanner {
  readonly id: ProviderId
  capabilities(): PlanningCapabilities
  plan(request: PlanningRequest): Promise<PlanningResult>
}

export interface MissionPlannerRegistry {
  get(id: ProviderId): MissionPlanner
  list(): ProviderId[]
  /** Padrao sensato quando o humano nao escolheu; `undefined` quando nao ha planejador. */
  default(): ProviderId | undefined
}
