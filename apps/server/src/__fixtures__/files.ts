/** Geradores de YAML para a suite do servidor. Sem CLI de agente e sem quota. */

export interface TaskFixture {
  readonly id: string
  readonly dependencies?: readonly string[]
  readonly touches?: readonly string[]
  readonly gate?: string | null
  readonly risk?: 'low' | 'medium' | 'high'
  readonly requireReview?: boolean
  readonly estimate?: number
}

export interface MissionFixture {
  readonly id?: string
  readonly tasks: readonly TaskFixture[]
  readonly missionGate?: string | null
  readonly defaultGate?: string | null
  readonly requireReview?: boolean
  readonly maxAttempts?: number
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
    '    validation: [o gate da task passa]',
    `    risk: ${task.risk ?? 'low'}`,
    `    estimate: ${task.estimate ?? 1}`,
  ]
  const gate = task.gate === undefined ? mission.defaultGate : task.gate
  if (gate !== null && gate !== undefined) lines.push(`    gate: ${gate}`)
  if (task.requireReview !== undefined) lines.push(`    requireReview: ${task.requireReview}`)
  return lines.join('\n')
}

export function missionYaml(mission: MissionFixture): string {
  const lines = [
    'apiVersion: agentic/v1',
    'kind: Mission',
    `id: ${mission.id ?? 'DA-SRV-001'}`,
    'title: missao de teste do servidor',
    'objective: exercitar a API de leitura, o SSE e os comandos',
    'acceptanceCriteria:',
    '  - todas as tasks concluidas com evidencia',
    'defaults:',
    `  requireReview: ${mission.requireReview ?? false}`,
    `  maxAttempts: ${mission.maxAttempts ?? 2}`,
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
  readonly providers?: readonly { readonly id: string; readonly maxConcurrent: number }[]
  readonly host?: string
  readonly port?: number
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
    `  workspace: ${project.workspace ?? 'shared'}`,
    '  worktreeRoot: .agentic/worktrees',
    `  maxParallelTasks: ${project.maxParallelTasks ?? 1}`,
    `  maxExecutors: ${project.maxExecutors ?? 1}`,
    `  maxReviewers: ${project.maxReviewers ?? 1}`,
    '  defaultMaxAttempts: 2',
    '  attemptTimeoutMinutes: 5',
    '  retryBackoffSeconds: 0',
    'policies:',
    '  enforceTouches: true',
    '  requireReviewByDefault: false',
    '  denyPaths: [.agentic/]',
    '  review:',
    '    default: fresh-session',
    '    byRisk:',
    '      low: fresh-session',
    '      medium: fresh-session',
    '      high: fresh-session',
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
  lines.push('server:', `  host: ${project.host ?? '127.0.0.1'}`, `  port: ${project.port ?? 4317}`)
  return `${lines.join('\n')}\n`
}

/** Gates reprodutiveis e sem dependencia de projeto: `node -e` sem shell. */
export const GATE_ALWAYS_PASS = "node -e 'process.exit(0)'"
export const GATE_ALWAYS_FAIL = "node -e 'process.exit(3)'"

export function gatesYaml(
  profiles: Readonly<Record<string, readonly string[]>> = { unit: [GATE_ALWAYS_PASS] },
): string {
  const lines = ['apiVersion: agentic/v1', 'kind: Gates', 'profiles:']
  for (const [id, commands] of Object.entries(profiles)) {
    lines.push(`  ${id}:`, '    commands:')
    for (const command of commands) lines.push(`      - run: ${JSON.stringify(command)}`)
  }
  lines.push('env:', '  allow: [PATH, HOME, LANG, NODE_ENV, TMPDIR]')
  return `${lines.join('\n')}\n`
}

/** Missao limpa: sem ERROR e sem WARNING. E o controle do teste de START MISSION. */
export const CLEAN_MISSION: MissionFixture = {
  id: 'DA-SRV-001',
  defaultGate: 'unit',
  missionGate: 'unit',
  tasks: [{ id: 'T01' }, { id: 'T02', dependencies: ['T01'] }],
}

/** DA2007: risk high com requireReview false — avisa, nao impede. */
export const WARNING_MISSION: MissionFixture = {
  id: 'DA-SRV-002',
  defaultGate: 'unit',
  missionGate: 'unit',
  tasks: [{ id: 'T01' }, { id: 'T02', dependencies: ['T01'], risk: 'high', requireReview: false }],
}

/** DA1003: dependencia inexistente — ERROR, nao vira run. */
export const ERROR_MISSION: MissionFixture = {
  id: 'DA-SRV-003',
  defaultGate: 'unit',
  missionGate: 'unit',
  tasks: [{ id: 'T01', dependencies: ['T99'] }],
}

/** Gate que reprova: leva a task a FAILED e da o que desbloquear. */
export const FAILING_MISSION: MissionFixture = {
  id: 'DA-SRV-004',
  defaultGate: 'flaky',
  missionGate: 'flaky',
  maxAttempts: 1,
  tasks: [{ id: 'T01' }],
}
