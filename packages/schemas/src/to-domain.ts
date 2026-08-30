import {
  agentProfileId,
  gateId,
  type MissionDefaults,
  type MissionSpec,
  missionId,
  type Phase,
  pathScope,
  phaseId,
  type TaskSpec,
  taskId,
} from '@agentic/domain'
import type {
  MissionFile,
  MissionFileDefaults,
  MissionFilePhase,
  MissionFileTask,
} from './mission-file.js'

/**
 * Traducao do arquivo para o dominio: o formato de arquivo nao vaza para dentro (ADR-0005).
 * Aqui os ids viram nominais e a heranca de `defaults` e aplicada — o dominio recebe a
 * task ja resolvida, nao a arvore de fallback.
 */
export function toMissionSpec(file: MissionFile): MissionSpec {
  const defaults = toMissionDefaults(file.defaults)
  return {
    id: missionId(file.id),
    title: file.title,
    objective: file.objective,
    description: file.description,
    scope: file.scope ?? [],
    outOfScope: file.outOfScope ?? [],
    constraints: file.constraints ?? [],
    acceptanceCriteria: file.acceptanceCriteria,
    defaults,
    phases: file.phases.map(toPhase),
    tasks: file.tasks.map((task) => toTaskSpec(task, defaults)),
    missionGate: file.missionGate === undefined ? undefined : gateId(file.missionGate),
  }
}

export function toMissionDefaults(defaults: MissionFileDefaults | undefined): MissionDefaults {
  if (defaults === undefined) return {}
  return {
    requireReview: defaults.requireReview,
    maxAttempts: defaults.maxAttempts,
    gate: defaults.gate === undefined ? undefined : gateId(defaults.gate),
    agentProfile:
      defaults.agentProfile === undefined ? undefined : agentProfileId(defaults.agentProfile),
    reviewPolicy: defaults.reviewPolicy,
  }
}

export function toPhase(phase: MissionFilePhase): Phase {
  return { id: phaseId(phase.id), title: phase.title, order: phase.order }
}

export function toTaskSpec(task: MissionFileTask, defaults: MissionDefaults = {}): TaskSpec {
  return {
    id: taskId(task.id),
    phase: phaseId(task.phase),
    title: task.title,
    objective: task.objective,
    description: task.description,
    dependencies: task.dependencies.map(taskId),
    touches: (task.touches ?? []).map(pathScope),
    reads: task.reads === undefined ? undefined : task.reads.map(pathScope),
    validation: task.validation ?? [],
    gate: task.gate === undefined ? defaults.gate : gateId(task.gate),
    requireReview: task.requireReview ?? defaults.requireReview,
    maxAttempts: task.maxAttempts ?? defaults.maxAttempts,
    risk: task.risk,
    estimate: task.estimate,
    agentProfile:
      task.agentProfile === undefined ? defaults.agentProfile : agentProfileId(task.agentProfile),
    reviewPolicy: task.reviewPolicy ?? defaults.reviewPolicy,
  }
}
