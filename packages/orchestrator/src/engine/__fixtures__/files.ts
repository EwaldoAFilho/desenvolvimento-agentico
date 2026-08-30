export interface TaskFixture {
  readonly id: string
  readonly dependencies?: readonly string[]
  readonly touches?: readonly string[]
  readonly gate?: string | null
  readonly requireReview?: boolean
  readonly risk?: 'low' | 'medium' | 'high'
  readonly reviewPolicy?: 'fresh-session' | 'cross-provider-preferred' | 'cross-provider-required'
  readonly maxAttempts?: number
  readonly estimate?: number
  readonly validation?: readonly string[]
}

export interface MissionFixture {
  readonly id?: string
  readonly tasks: readonly TaskFixture[]
  readonly missionGate?: string | null
  readonly requireReview?: boolean
  readonly maxAttempts?: number
  readonly defaultGate?: string | null
}

const list = (values: readonly string[]): string =>
  values.length === 0 ? '[]' : `[${values.join(', ')}]`

function taskYaml(task: TaskFixture, mission: MissionFixture): string {
  const lines = [
    `  - id: ${task.id}`,
    '    phase: build',
    `    title: task ${task.id}`,
    `    objective: entregar ${task.id} com prova`,
    `    dependencies: ${list(task.dependencies ?? [])}`,
    `    touches: ${list(task.touches ?? [`packages/${task.id.toLowerCase()}/`])}`,
    `    validation: ${list(task.validation ?? ['o gate da task passa'])}`,
    `    risk: ${task.risk ?? 'low'}`,
    `    estimate: ${task.estimate ?? 1}`,
  ]
  const gate = task.gate === undefined ? mission.defaultGate : task.gate
  if (gate !== null && gate !== undefined) lines.push(`    gate: ${gate}`)
  if (task.requireReview !== undefined) lines.push(`    requireReview: ${task.requireReview}`)
  if (task.maxAttempts !== undefined) lines.push(`    maxAttempts: ${task.maxAttempts}`)
  if (task.reviewPolicy !== undefined) lines.push(`    reviewPolicy: ${task.reviewPolicy}`)
  return lines.join('\n')
}

export function missionYaml(mission: MissionFixture): string {
  const lines = [
    'apiVersion: agentic/v1',
    'kind: Mission',
    `id: ${mission.id ?? 'DA-TEST-001'}`,
    'title: missao de teste do orquestrador',
    'objective: exercitar o ciclo completo com provider mock',
    'acceptanceCriteria:',
    '  - todas as tasks concluidas com evidencia',
    'defaults:',
    `  requireReview: ${mission.requireReview ?? false}`,
    `  maxAttempts: ${mission.maxAttempts ?? 3}`,
  ]
  if (mission.defaultGate !== null && mission.defaultGate !== undefined) {
    lines.push(`  gate: ${mission.defaultGate}`)
  }
  if (mission.missionGate !== null && mission.missionGate !== undefined) {
    lines.push(`missionGate: ${mission.missionGate}`)
  }
  lines.push('phases:', '  - id: build', '    title: Build', 'tasks:')
  for (const task of mission.tasks) lines.push(taskYaml(task, mission))
  return `${lines.join('\n')}\n`
}

export interface ProjectFixture {
  readonly workspace?: 'git-worktree' | 'shared'
  readonly maxParallelTasks?: number
  readonly maxExecutors?: number
  readonly maxReviewers?: number
  readonly defaultMaxAttempts?: number
  readonly retryBackoffSeconds?: number
  readonly attemptTimeoutMinutes?: number
  readonly providers?: readonly { readonly id: string; readonly maxConcurrent: number }[]
  readonly reviewDefault?: string
  readonly missionGate?: string | null
  readonly denyPaths?: readonly string[]
}

export function projectYaml(project: ProjectFixture = {}): string {
  const providers = project.providers ?? [{ id: 'mock', maxConcurrent: 4 }]
  const lines = [
    'apiVersion: agentic/v1',
    'kind: Project',
    'project:',
    '  name: orquestrador-teste',
    '  repoRoot: .',
    'execution:',
    `  workspace: ${project.workspace ?? 'git-worktree'}`,
    '  worktreeRoot: .agentic/worktrees',
    `  maxParallelTasks: ${project.maxParallelTasks ?? 4}`,
    `  maxExecutors: ${project.maxExecutors ?? 4}`,
    `  maxReviewers: ${project.maxReviewers ?? 2}`,
    `  defaultMaxAttempts: ${project.defaultMaxAttempts ?? 3}`,
    `  attemptTimeoutMinutes: ${project.attemptTimeoutMinutes ?? 5}`,
    `  retryBackoffSeconds: ${project.retryBackoffSeconds ?? 0}`,
    'policies:',
    '  enforceTouches: true',
    '  requireReviewByDefault: false',
    `  denyPaths: ${list(project.denyPaths ?? ['.agentic/'])}`,
    '  review:',
    `    default: ${project.reviewDefault ?? 'fresh-session'}`,
    '    byRisk:',
    '      low: fresh-session',
    '      medium: fresh-session',
    '      high: cross-provider-required',
    'integration:',
    '  missionBranchPrefix: mission/',
    '  taskBranchPrefix: task/',
    'providers:',
    `  default: ${providers[0]?.id ?? 'mock'}`,
    '  registry:',
  ]
  for (const provider of providers) {
    lines.push(
      `    ${provider.id}:`,
      '      kind: inprocess',
      `      maxConcurrent: ${provider.maxConcurrent}`,
      '      roles: [executor, reviewer]',
    )
  }
  lines.push('gates:', '  file: .agentic/gates.yaml')
  if (project.missionGate !== null && project.missionGate !== undefined) {
    lines.push(`  missionGate: ${project.missionGate}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Perfis de gate reprodutiveis e sem dependencia de projeto: `node -e` com aspas simples,
 * que o tokenizador aceita sem shell (P08).
 */
export const GATE_ALWAYS_PASS = "node -e 'process.exit(0)'"
export const GATE_ALWAYS_FAIL = "node -e 'process.exit(3)'"
/** Reprova na primeira tentativa e passa da segunda em diante (le a worktree corrente). */
export const GATE_FIRST_ATTEMPT_FAILS =
  "node -e 'process.exit(/-a1$/.test(process.cwd()) ? 4 : 0)'"
export const GATE_PRINT_BRANCH = 'git rev-parse --abbrev-ref HEAD'

export function gatesYaml(profiles: Readonly<Record<string, readonly string[]>>): string {
  const lines = ['apiVersion: agentic/v1', 'kind: Gates', 'profiles:']
  for (const [id, commands] of Object.entries(profiles)) {
    lines.push(`  ${id}:`, '    commands:')
    for (const command of commands) lines.push(`      - run: ${JSON.stringify(command)}`)
  }
  lines.push('env:', '  allow: [PATH, HOME, LANG, NODE_ENV, TMPDIR]')
  return `${lines.join('\n')}\n`
}
