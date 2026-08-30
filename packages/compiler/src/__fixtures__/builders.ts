import type { CompileInput } from '../types.js'

/**
 * Construtores de YAML para as fixtures de diagnostico. Uma fixture por codigo do catalogo:
 * a base nao produz diagnostico nenhum, e cada teste muda UM detalhe.
 *
 * `null` num campo significa "omite a chave"; `undefined` significa "usa o default".
 */
export interface TaskDraft {
  readonly id: string
  readonly phase?: string
  readonly title?: string
  readonly objective?: string
  readonly dependencies?: readonly string[]
  readonly touches?: readonly string[] | null
  readonly validation?: readonly string[] | null
  readonly gate?: string | null
  readonly risk?: 'low' | 'medium' | 'high'
  readonly estimate?: number
  readonly requireReview?: boolean
  readonly agentProfile?: string
  readonly reviewPolicy?: string
  /** Linhas cruas anexadas a task, para exercitar falha de schema. */
  readonly raw?: readonly string[]
}

export interface PhaseDraft {
  readonly id: string
  readonly title?: string
  readonly order?: number
}

export interface MissionDraft {
  readonly id?: string
  readonly phases?: readonly PhaseDraft[]
  readonly defaultsGate?: string | null
  readonly defaultsAgentProfile?: string | null
  readonly defaultsReviewPolicy?: string
  readonly missionGate?: string | null
  readonly tasks?: readonly TaskDraft[]
}

const quote = (value: string): string => JSON.stringify(value)

function list(indent: string, key: string, values: readonly string[]): string[] {
  if (values.length === 0) return [`${indent}${key}: []`]
  return [`${indent}${key}:`, ...values.map((value) => `${indent}  - ${quote(value)}`)]
}

function taskLines(draft: TaskDraft): string[] {
  const id = draft.id
  const lines = [
    `  - id: ${id}`,
    `    phase: ${draft.phase ?? 'alpha'}`,
    `    title: ${quote(draft.title ?? `Task ${id}`)}`,
    `    objective: ${quote(draft.objective ?? `Entrega verificavel de ${id}.`)}`,
    `    dependencies: [${(draft.dependencies ?? []).join(', ')}]`,
  ]
  if (draft.touches !== null) {
    lines.push(...list('    ', 'touches', draft.touches ?? [`packages/${id.toLowerCase()}/`]))
  }
  if (draft.validation !== null) {
    lines.push(...list('    ', 'validation', draft.validation ?? [`${id} coberta por teste`]))
  }
  const gate = draft.gate === undefined ? 'unit' : draft.gate
  if (gate !== null) lines.push(`    gate: ${gate}`)
  lines.push(`    risk: ${draft.risk ?? 'low'}`)
  lines.push(`    estimate: ${draft.estimate ?? 2}`)
  if (draft.requireReview !== undefined) lines.push(`    requireReview: ${draft.requireReview}`)
  if (draft.agentProfile !== undefined) lines.push(`    agentProfile: ${draft.agentProfile}`)
  if (draft.reviewPolicy !== undefined) lines.push(`    reviewPolicy: ${draft.reviewPolicy}`)
  for (const line of draft.raw ?? []) lines.push(`    ${line}`)
  return lines
}

/** Base sem diagnostico: quatro tasks, uma fase, escopos disjuntos, terminal no mission gate. */
export const BASE_TASKS: readonly TaskDraft[] = [
  { id: 'T01' },
  { id: 'T02', dependencies: ['T01'] },
  { id: 'T03', dependencies: ['T01'] },
  { id: 'T04', dependencies: ['T02', 'T03'], gate: 'mission' },
]

export function missionYaml(draft: MissionDraft = {}): string {
  const phases = draft.phases ?? [{ id: 'alpha' }]
  const tasks = draft.tasks ?? BASE_TASKS
  const lines = [
    'apiVersion: agentic/v1',
    'kind: Mission',
    '',
    `id: ${draft.id ?? 'DA-TEST-001'}`,
    'title: Missao de teste do compilador',
    'objective: Exercitar o catalogo de diagnosticos com um plano pequeno e verificavel.',
    'acceptanceCriteria:',
    '  - O compilador devolve o diagnostico esperado',
    'defaults:',
    '  requireReview: true',
    '  maxAttempts: 3',
  ]
  const defaultsGate = draft.defaultsGate === undefined ? 'unit' : draft.defaultsGate
  if (defaultsGate !== null) lines.push(`  gate: ${defaultsGate}`)
  const defaultsProfile =
    draft.defaultsAgentProfile === undefined ? 'executor' : draft.defaultsAgentProfile
  if (defaultsProfile !== null) lines.push(`  agentProfile: ${defaultsProfile}`)
  if (draft.defaultsReviewPolicy !== undefined) {
    lines.push(`  reviewPolicy: ${draft.defaultsReviewPolicy}`)
  }

  lines.push('phases:')
  for (const phase of phases) {
    lines.push(`  - id: ${phase.id}`)
    lines.push(`    title: ${quote(phase.title ?? `Fase ${phase.id}`)}`)
    if (phase.order !== undefined) lines.push(`    order: ${phase.order}`)
  }

  lines.push('tasks:')
  for (const task of tasks) lines.push(...taskLines(task))

  const missionGate = draft.missionGate === undefined ? 'mission' : draft.missionGate
  if (missionGate !== null) lines.push(`missionGate: ${missionGate}`)
  return `${lines.join('\n')}\n`
}

export interface ProviderDraft {
  readonly kind?: 'local-cli' | 'inprocess'
  readonly command?: string
  readonly maxConcurrent?: number
  readonly roles?: readonly ('executor' | 'reviewer')[]
  readonly profiles?: Readonly<Record<string, 'executor' | 'reviewer'>>
}

export interface ProjectDraft {
  readonly workspace?: 'git-worktree' | 'shared'
  readonly maxParallelTasks?: number
  readonly denyPaths?: readonly string[]
  readonly requireReviewByDefault?: boolean
  readonly reviewDefault?: string
  readonly byRisk?: Readonly<Record<'low' | 'medium' | 'high', string>>
  readonly defaultProvider?: string
  readonly providers?: Readonly<Record<string, ProviderDraft>>
  readonly missionGate?: string | null
}

const DEFAULT_PROVIDERS: Readonly<Record<string, ProviderDraft>> = {
  'alpha-cli': {
    kind: 'local-cli',
    command: 'alpha',
    maxConcurrent: 3,
    roles: ['executor', 'reviewer'],
    profiles: { executor: 'executor', reviewer: 'reviewer' },
  },
  'beta-cli': {
    kind: 'local-cli',
    command: 'beta',
    maxConcurrent: 2,
    roles: ['executor', 'reviewer'],
    profiles: { executor: 'executor', reviewer: 'reviewer' },
  },
}

export function projectYaml(draft: ProjectDraft = {}): string {
  const providers = draft.providers ?? DEFAULT_PROVIDERS
  const byRisk = draft.byRisk ?? {
    low: 'fresh-session',
    medium: 'cross-provider-preferred',
    high: 'cross-provider-required',
  }
  const lines = [
    'apiVersion: agentic/v1',
    'kind: Project',
    '',
    'project:',
    '  name: projeto-de-teste',
    '  repoRoot: .',
    '',
    'execution:',
    `  workspace: ${draft.workspace ?? 'git-worktree'}`,
    '  worktreeRoot: .agentic/worktrees',
    `  maxParallelTasks: ${draft.maxParallelTasks ?? 3}`,
    '  maxExecutors: 3',
    '  maxReviewers: 2',
    '  defaultMaxAttempts: 3',
    '  attemptTimeoutMinutes: 30',
    '  retryBackoffSeconds: 15',
    '',
    'policies:',
    '  enforceTouches: true',
    `  requireReviewByDefault: ${draft.requireReviewByDefault ?? true}`,
    ...list('  ', 'denyPaths', [...(draft.denyPaths ?? ['.agentic/', '.git/', '.env', '*.pem'])]),
    '  review:',
    `    default: ${draft.reviewDefault ?? 'cross-provider-preferred'}`,
    '    byRisk:',
    `      low: ${byRisk.low}`,
    `      medium: ${byRisk.medium}`,
    `      high: ${byRisk.high}`,
    '',
    'providers:',
    `  default: ${draft.defaultProvider ?? Object.keys(providers)[0] ?? 'alpha-cli'}`,
    '  registry:',
  ]
  for (const [id, provider] of Object.entries(providers)) {
    lines.push(`    ${id}:`)
    lines.push(`      kind: ${provider.kind ?? 'local-cli'}`)
    if ((provider.kind ?? 'local-cli') === 'local-cli') {
      lines.push(`      command: ${provider.command ?? id}`)
    }
    lines.push(`      maxConcurrent: ${provider.maxConcurrent ?? 2}`)
    lines.push(`      roles: [${(provider.roles ?? ['executor', 'reviewer']).join(', ')}]`)
    const profiles = provider.profiles ?? {}
    if (Object.keys(profiles).length > 0) {
      lines.push('      profiles:')
      for (const [profile, role] of Object.entries(profiles)) {
        lines.push(`        ${profile}: { role: ${role} }`)
      }
    }
  }

  lines.push('')
  lines.push('gates:')
  lines.push('  file: .agentic/gates.yaml')
  const missionGate = draft.missionGate === undefined ? 'mission' : draft.missionGate
  if (missionGate !== null) lines.push(`  missionGate: ${missionGate}`)
  return `${lines.join('\n')}\n`
}

export function gatesYaml(profiles: readonly string[] = ['unit', 'mission']): string {
  const lines = ['apiVersion: agentic/v1', 'kind: Gates', '', 'profiles:']
  for (const profile of profiles) {
    lines.push(`  ${profile}:`)
    lines.push('    commands:')
    lines.push(`      - run: npm run test:${profile}`)
  }
  lines.push('')
  lines.push('env:')
  lines.push('  allow: [PATH, HOME]')
  return `${lines.join('\n')}\n`
}

export interface InputDraft {
  readonly mission?: MissionDraft | string
  readonly project?: ProjectDraft | string
  readonly gates?: readonly string[] | string
}

/** Monta os tres textos de entrada; o que nao for citado usa a base limpa. */
export function compileInput(draft: InputDraft = {}): CompileInput {
  const mission = draft.mission
  const project = draft.project
  const gates = draft.gates
  return {
    missionText: typeof mission === 'string' ? mission : missionYaml(mission),
    projectFile: typeof project === 'string' ? project : projectYaml(project),
    gatesFile: typeof gates === 'string' ? gates : gatesYaml(gates),
  }
}
