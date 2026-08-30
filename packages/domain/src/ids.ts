import { InvalidIdError } from './errors.js'

/**
 * Tipo nominal sobre um primitivo. A marca so existe no sistema de tipos: em runtime o
 * valor continua sendo a string original, entao serializa e compara sem adaptador.
 */
export type Brand<TValue, TBrand extends string> = TValue & { readonly __brand: TBrand }

export type MissionId = Brand<string, 'MissionId'>
export type TaskId = Brand<string, 'TaskId'>
export type PhaseId = Brand<string, 'PhaseId'>
export type RunId = Brand<string, 'RunId'>
export type TaskRunId = Brand<string, 'TaskRunId'>
export type AttemptId = Brand<string, 'AttemptId'>
export type ProviderId = Brand<string, 'ProviderId'>
export type AgentProfileId = Brand<string, 'AgentProfileId'>
export type GateId = Brand<string, 'GateId'>

export const MISSION_ID_PATTERN = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d{3,}$/
export const TASK_ID_PATTERN = /^[A-Z]\d{2,}$/
export const PHASE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
/** ULID em Crockford base32 (sem I, L, O, U). */
export const RUN_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/
export const TASK_RUN_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}:[A-Z]\d{2,}$/
export const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
/** Id opaco vindo de configuracao: o dominio nunca interpreta o conteudo (P18). */
export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const AGENT_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const GATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function matches(pattern: RegExp, raw: unknown): boolean {
  return typeof raw === 'string' && raw.length > 0 && pattern.test(raw)
}

function idFactory<TId extends string>(kind: string, pattern: RegExp): (raw: string) => TId {
  return (raw: string): TId => {
    if (!matches(pattern, raw)) throw new InvalidIdError(kind, raw, pattern.source)
    return raw as TId
  }
}

function idGuard<TId extends string>(pattern: RegExp): (raw: unknown) => raw is TId {
  return (raw: unknown): raw is TId => matches(pattern, raw)
}

export const missionId = idFactory<MissionId>('MissionId', MISSION_ID_PATTERN)
export const taskId = idFactory<TaskId>('TaskId', TASK_ID_PATTERN)
export const phaseId = idFactory<PhaseId>('PhaseId', PHASE_ID_PATTERN)
export const runId = idFactory<RunId>('RunId', RUN_ID_PATTERN)
export const attemptId = idFactory<AttemptId>('AttemptId', ATTEMPT_ID_PATTERN)
export const providerId = idFactory<ProviderId>('ProviderId', PROVIDER_ID_PATTERN)
export const agentProfileId = idFactory<AgentProfileId>('AgentProfileId', AGENT_PROFILE_ID_PATTERN)
export const gateId = idFactory<GateId>('GateId', GATE_ID_PATTERN)

export const isMissionId = idGuard<MissionId>(MISSION_ID_PATTERN)
export const isTaskId = idGuard<TaskId>(TASK_ID_PATTERN)
export const isPhaseId = idGuard<PhaseId>(PHASE_ID_PATTERN)
export const isRunId = idGuard<RunId>(RUN_ID_PATTERN)
export const isAttemptId = idGuard<AttemptId>(ATTEMPT_ID_PATTERN)
export const isProviderId = idGuard<ProviderId>(PROVIDER_ID_PATTERN)
export const isAgentProfileId = idGuard<AgentProfileId>(AGENT_PROFILE_ID_PATTERN)
export const isGateId = idGuard<GateId>(GATE_ID_PATTERN)

/** TaskRun nao tem id proprio: e a composicao (run, task). */
export function taskRunId(run: RunId, task: TaskId): TaskRunId {
  return `${run}:${task}` as TaskRunId
}

export function parseTaskRunId(raw: string): { run: RunId; task: TaskId } {
  if (!matches(TASK_RUN_ID_PATTERN, raw)) {
    throw new InvalidIdError('TaskRunId', raw, TASK_RUN_ID_PATTERN.source)
  }
  const separator = raw.indexOf(':')
  return {
    run: raw.slice(0, separator) as RunId,
    task: raw.slice(separator + 1) as TaskId,
  }
}
