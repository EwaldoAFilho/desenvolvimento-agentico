import type { AgentProfileId, GateId, MissionId, PhaseId, TaskId } from './ids.js'
import type { PathScope } from './path-scope.js'
import type { ReviewPolicy } from './review.js'

export const RISKS = ['low', 'medium', 'high'] as const
export type Risk = (typeof RISKS)[number]

export function isRisk(value: unknown): value is Risk {
  return typeof value === 'string' && (RISKS as readonly string[]).includes(value)
}

/** Referencia a um perfil de gate declarado fora da missao (`.agentic/gates.yaml`). */
export type GateRef = GateId

export interface MissionDefaults {
  readonly requireReview?: boolean
  readonly maxAttempts?: number
  readonly gate?: GateRef
  readonly agentProfile?: AgentProfileId
  readonly reviewPolicy?: ReviewPolicy
}

/** Agrupamento logico e visual. Fase nao cria dependencia (P02). */
export interface Phase {
  readonly id: PhaseId
  readonly title: string
  readonly order?: number
}

export interface TaskSpec {
  readonly id: TaskId
  readonly phase: PhaseId
  readonly title: string
  readonly objective: string
  readonly description?: string
  readonly dependencies: readonly TaskId[]
  readonly touches: readonly PathScope[]
  readonly reads?: readonly PathScope[]
  readonly validation: readonly string[]
  readonly gate?: GateRef
  readonly requireReview?: boolean
  readonly maxAttempts?: number
  readonly risk: Risk
  readonly estimate?: number
  readonly agentProfile?: AgentProfileId
  readonly reviewPolicy?: ReviewPolicy
}

export interface MissionSpec {
  readonly id: MissionId
  readonly title: string
  readonly objective: string
  readonly description?: string
  readonly scope: readonly string[]
  readonly outOfScope: readonly string[]
  readonly constraints: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly defaults: MissionDefaults
  readonly phases: readonly Phase[]
  readonly tasks: readonly TaskSpec[]
  readonly missionGate?: GateRef
}

/** Aresta dirigida finish-to-start: `to` nao inicia antes de `from` estar DONE. */
export interface Dependency {
  readonly from: TaskId
  readonly to: TaskId
}

export function missionDependencies(spec: MissionSpec): Dependency[] {
  const edges: Dependency[] = []
  for (const task of spec.tasks) {
    for (const from of task.dependencies) edges.push({ from, to: task.id })
  }
  return edges
}

export function taskDependents(spec: MissionSpec, target: TaskId): TaskId[] {
  return spec.tasks.filter((task) => task.dependencies.includes(target)).map((task) => task.id)
}

export interface EffectiveTaskSettings {
  readonly requireReview: boolean
  readonly maxAttempts: number
  readonly gate?: GateRef
  readonly agentProfile?: AgentProfileId
}

export const DEFAULT_REQUIRE_REVIEW = true
export const DEFAULT_MAX_ATTEMPTS = 3

export function resolveTaskSettings(
  task: TaskSpec,
  defaults: MissionDefaults = {},
): EffectiveTaskSettings {
  return {
    requireReview: task.requireReview ?? defaults.requireReview ?? DEFAULT_REQUIRE_REVIEW,
    maxAttempts: task.maxAttempts ?? defaults.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    gate: task.gate ?? defaults.gate,
    agentProfile: task.agentProfile ?? defaults.agentProfile,
  }
}

/** Invariantes de TaskSpec (DOMAIN-MODEL 2.3). Devolve a lista de violacoes, vazia se ok. */
export function checkTaskSpecInvariants(task: TaskSpec): string[] {
  const problems: string[] = []
  if (task.objective.trim().length === 0) problems.push('objective nao pode ser vazio')
  if (task.dependencies.includes(task.id)) problems.push('dependencies nao pode auto-referenciar')
  if (new Set(task.dependencies).size !== task.dependencies.length) {
    problems.push('dependencies nao pode repetir id')
  }
  const maxAttempts = task.maxAttempts
  if (maxAttempts !== undefined && maxAttempts < 1) problems.push('maxAttempts deve ser >= 1')
  return problems
}

export function checkMissionSpecInvariants(spec: MissionSpec): string[] {
  const problems: string[] = []
  const phases = new Set<string>(spec.phases.map((phase) => phase.id))
  if (phases.size !== spec.phases.length) problems.push('phases com id repetido')
  const ids = new Set<string>()
  for (const task of spec.tasks) {
    if (ids.has(task.id)) problems.push(`task com id repetido: ${task.id}`)
    ids.add(task.id)
    if (!phases.has(task.phase)) problems.push(`task ${task.id} referencia fase inexistente`)
    for (const problem of checkTaskSpecInvariants(task))
      problems.push(`task ${task.id}: ${problem}`)
  }
  for (const task of spec.tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency))
        problems.push(`task ${task.id} depende de ${dependency} inexistente`)
    }
  }
  return problems
}
