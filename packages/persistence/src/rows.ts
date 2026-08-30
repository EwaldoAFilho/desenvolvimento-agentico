/**
 * Linhas cruas do banco, com o nome de coluna do ARCHITECTURE 6.1. O dashboard monta o DTO
 * no server: este pacote nao conhece o contrato de API.
 */
export type RunRow = {
  readonly id: string
  readonly mission_id: string
  readonly spec_hash: string
  readonly status: string
  readonly policies_json: string
  readonly graph_json: string
  readonly created_at: string
  readonly approved_at: string | null
  readonly started_at: string | null
  readonly finished_at: string | null
  readonly integration_branch: string | null
  readonly mission_gate_id: string | null
  readonly mission_gate_execution_id: string | null
  readonly failure_reason: string | null
}

export type TaskRunRow = {
  readonly run_id: string
  readonly task_id: string
  readonly status: string
  readonly attempt_count: number
  readonly current_attempt_id: string | null
  readonly unblocked_by_json: string
  readonly ready_at: string | null
  readonly started_at: string | null
  readonly finished_at: string | null
  readonly outcome: string | null
  readonly blockage_json: string | null
}

export type AttemptRow = {
  readonly id: string
  readonly run_id: string
  readonly task_id: string
  readonly attempt_number: number
  readonly executor_json: string
  readonly dispatch_reason_json: string
  readonly workspace_json: string
  readonly started_at: string
  readonly finished_at: string | null
  readonly duration_ms: number | null
  readonly result: string | null
  readonly failure_code: string | null
  readonly failure_detail: string | null
  readonly claims_json: string | null
  readonly observation_json: string | null
  readonly usage_json: string | null
}

export type GateExecutionRow = {
  readonly id: string
  readonly run_id: string
  readonly scope: string
  readonly gate_id: string
  readonly attempt_id: string | null
  readonly status: string
  readonly started_at: string
  readonly finished_at: string | null
  readonly results_json: string
}

export type ReviewRow = {
  readonly id: string
  readonly attempt_id: string
  readonly reviewer_json: string
  readonly verdict: string
  readonly findings_json: string
  readonly rationale: string
  readonly duration_ms: number
  readonly input_json: string
  readonly policy: string
  readonly policy_outcome: string
  readonly policy_outcome_reason: string | null
}

export type EventRow = {
  readonly seq: number
  readonly run_id: string
  readonly ts: string
  readonly type: string
  readonly actor: string
  readonly task_id: string | null
  readonly attempt_id: string | null
  readonly payload_json: string
}

export type LockRow = {
  readonly run_id: string
  readonly path_prefix: string
  readonly attempt_id: string
  readonly acquired_at: string
}

export type ArtifactRow = {
  readonly id: string
  readonly run_id: string
  readonly kind: string
  readonly path: string
  readonly digest: string
  readonly bytes: number
  readonly created_at: string
}

/** Uma linha por (run, status de task) — o cabecalho do dashboard nao precisa de mais. */
export type TaskStatusCountRow = {
  readonly status: string
  readonly total: number
}

export type RunListRow = {
  readonly id: string
  readonly mission_id: string
  readonly status: string
  readonly created_at: string
  readonly started_at: string | null
  readonly finished_at: string | null
  readonly task_total: number
  readonly task_done: number
}
