import { type RunSnapshot, TaskStatusSchema } from '@agentic/schemas'

export type TaskStatus = RunSnapshot['tasks'][number]['status']
export type RunStatus = RunSnapshot['run']['status']

/** Ordem do contrato — a UI nao inventa um decimo terceiro estado (DASHBOARD 3). */
export const TASK_STATUSES: readonly TaskStatus[] = TaskStatusSchema.options

export type BorderShape = 'dashed' | 'thin' | 'thick' | 'thick-dashed' | 'double'

/**
 * Cor **nunca** e o unico diferenciador: cada estado carrega icone e rotulo textual, e o nome
 * do estado e o proprio rotulo. Um daltonico e uma captura em preto e branco funcionam
 * (DASHBOARD 3).
 */
export interface TaskStatusStyle {
  readonly status: TaskStatus
  readonly icon: string
  readonly label: string
  readonly colorVar: string
  readonly border: BorderShape
  readonly pulse: boolean
}

const STYLES: Record<TaskStatus, TaskStatusStyle> = {
  PENDING: {
    status: 'PENDING',
    icon: '○',
    label: 'PENDING',
    colorVar: '--st-gray',
    border: 'dashed',
    pulse: false,
  },
  READY: {
    status: 'READY',
    icon: '◔',
    label: 'READY',
    colorVar: '--st-blue',
    border: 'thin',
    pulse: false,
  },
  RUNNING: {
    status: 'RUNNING',
    icon: '▶',
    label: 'RUNNING',
    colorVar: '--st-blue-strong',
    border: 'thick',
    pulse: true,
  },
  VERIFYING: {
    status: 'VERIFYING',
    icon: '⚙',
    label: 'VERIFYING',
    colorVar: '--st-purple',
    border: 'thick',
    pulse: false,
  },
  REVIEW: {
    status: 'REVIEW',
    icon: '⟳',
    label: 'REVIEW',
    colorVar: '--st-purple',
    border: 'thick',
    pulse: false,
  },
  INTEGRATING: {
    status: 'INTEGRATING',
    icon: '⇉',
    label: 'INTEGRATING',
    colorVar: '--st-cyan',
    border: 'thick',
    pulse: false,
  },
  DONE: {
    status: 'DONE',
    icon: '✔',
    label: 'DONE',
    colorVar: '--st-green',
    border: 'thin',
    pulse: false,
  },
  FAILED: {
    status: 'FAILED',
    icon: '✖',
    label: 'FAILED',
    colorVar: '--st-red',
    border: 'thick',
    pulse: false,
  },
  RETRY: {
    status: 'RETRY',
    icon: '↻',
    label: 'RETRY',
    colorVar: '--st-orange',
    border: 'thick-dashed',
    pulse: false,
  },
  BLOCKED: {
    status: 'BLOCKED',
    icon: '⊘',
    label: 'BLOCKED',
    colorVar: '--st-amber',
    border: 'double',
    pulse: false,
  },
  SKIPPED: {
    status: 'SKIPPED',
    icon: '—',
    label: 'SKIPPED',
    colorVar: '--st-gray-light',
    border: 'dashed',
    pulse: false,
  },
  CANCELLED: {
    status: 'CANCELLED',
    icon: '⊗',
    label: 'CANCELLED',
    colorVar: '--st-gray-dark',
    border: 'dashed',
    pulse: false,
  },
}

export function taskStatusStyle(status: TaskStatus): TaskStatusStyle {
  return STYLES[status]
}

/** Dependencia satisfeita: `DONE` ou `SKIPPED` (STATE-MACHINES, transicao 2). */
export function isDependencySatisfied(status: TaskStatus): boolean {
  return status === 'DONE' || status === 'SKIPPED'
}

const RUN_STATUS_ICON: Record<RunStatus, string> = {
  DRAFT: '○',
  APPROVED: '◔',
  RUNNING: '●',
  PAUSED: '⏸',
  BLOCKED: '⊘',
  VERIFYING: '⚙',
  COMPLETED: '✔',
  FAILED: '✖',
  CANCELLED: '⊗',
}

export function runStatusIcon(status: RunStatus): string {
  return RUN_STATUS_ICON[status]
}
