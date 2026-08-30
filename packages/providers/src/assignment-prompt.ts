import type {
  Assignment,
  ExecuteAssignment,
  GateExecution,
  ReviewAssignment,
} from '@agentic/domain'

export interface PromptSection {
  readonly title: string
  readonly lines: readonly string[]
}

export interface AssignmentPrompt {
  readonly heading: string
  readonly sections: readonly PromptSection[]
  readonly text: string
}

const NONE = '(nenhum)'

function bullets(values: readonly string[]): string[] {
  return values.length === 0 ? [NONE] : values.map((value) => `- ${value}`)
}

function identity(assignment: Assignment): PromptSection {
  return {
    title: 'Identificacao',
    lines: [
      `- missao: ${assignment.missionId}`,
      `- run: ${assignment.runId}`,
      `- task: ${assignment.taskId}`,
      `- tentativa: ${assignment.attemptId}`,
      `- papel: ${assignment.kind === 'review' ? 'revisor' : 'executor'}`,
    ],
  }
}

function scopeSections(assignment: Assignment): PromptSection[] {
  const sections: PromptSection[] = [
    { title: 'Escopo de escrita permitido (touches)', lines: bullets([...assignment.touches]) },
  ]
  if (assignment.reads.length > 0) {
    sections.push({ title: 'Escopo de leitura (reads)', lines: bullets([...assignment.reads]) })
  }
  if (assignment.denyPaths.length > 0) {
    sections.push({
      title: 'Caminhos proibidos (denyPaths)',
      lines: bullets([...assignment.denyPaths]),
    })
  }
  return sections
}

function workspaceSection(assignment: Assignment): PromptSection {
  return {
    title: 'Workspace',
    lines: [
      `- diretorio de trabalho: ${assignment.workspacePath}`,
      '- todo caminho citado acima e relativo a raiz deste diretorio',
      `- limite de tempo desta tentativa: ${assignment.timeoutMs} ms`,
    ],
  }
}

/** Uma linha por comando: o revisor le fato reproduzivel, nao resumo (P08). */
function gateLines(executions: readonly GateExecution[]): string[] {
  if (executions.length === 0) return [NONE]
  const lines: string[] = []
  for (const execution of executions) {
    lines.push(`- gate ${execution.gateId} (${execution.scope}): ${execution.status}`)
    for (const result of execution.results) {
      const code = result.exitCode === null ? 'sem codigo' : `exit ${result.exitCode}`
      const timedOut = result.timedOut === true ? ', expirou' : ''
      lines.push(`  - \`${result.command}\` -> ${code}${timedOut} (${result.durationMs} ms)`)
    }
  }
  return lines
}

function executeSections(assignment: ExecuteAssignment): PromptSection[] {
  const sections: PromptSection[] = [identity(assignment)]
  sections.push({ title: 'Objetivo', lines: [assignment.objective] })
  if (assignment.description !== undefined && assignment.description.trim().length > 0) {
    sections.push({ title: 'Descricao', lines: [assignment.description] })
  }
  sections.push(...scopeSections(assignment))
  if (assignment.constraints.length > 0) {
    sections.push({ title: 'Restricoes', lines: bullets([...assignment.constraints]) })
  }
  sections.push({
    title: 'Dependencias satisfeitas',
    lines: bullets([...assignment.satisfiedDependencies]),
  })
  sections.push({
    title: 'Contrato de validacao',
    lines: bullets([...assignment.validation]),
  })
  sections.push(workspaceSection(assignment))
  sections.push({
    title: 'Como responder',
    lines: [
      '- altere apenas os caminhos do escopo de escrita',
      '- termine com um resumo de uma linha do que foi feito',
      '- o control plane mede o diff e roda os gates: nao afirme aprovacao, entregue trabalho',
    ],
  })
  return sections
}

/**
 * P07: o revisor recebe evidencia — diff medido e resultado de gate — e nunca a narrativa
 * do executor. `ReviewAssignment` nao carrega `claims`, e esta funcao nao inventa um.
 */
function reviewSections(assignment: ReviewAssignment): PromptSection[] {
  const sections: PromptSection[] = [identity(assignment)]
  sections.push({ title: 'Objetivo da task revisada', lines: [assignment.objective] })
  sections.push(...scopeSections(assignment))
  if (assignment.constraints.length > 0) {
    sections.push({ title: 'Restricoes declaradas', lines: bullets([...assignment.constraints]) })
  }
  sections.push({ title: 'Contrato de validacao', lines: bullets([...assignment.validation]) })
  sections.push({ title: 'Diff observado', lines: [`- referencia: ${assignment.diffRef}`] })
  sections.push({ title: 'Resultados de gate', lines: gateLines(assignment.gateExecutions) })
  sections.push({ title: 'Politica de revisao', lines: [`- ${assignment.policy}`] })
  sections.push(workspaceSection(assignment))
  sections.push({
    title: 'Como responder',
    lines: [
      '- veredito em uma linha: PASS, FAIL ou ESCALATE',
      '- cada apontamento com caminho, linha quando houver, e severidade',
      '- julgue o diff e os gates; nao ha relato do executor a considerar',
    ],
  })
  return sections
}

export function assignmentSections(assignment: Assignment): PromptSection[] {
  return assignment.kind === 'review' ? reviewSections(assignment) : executeSections(assignment)
}

export function assignmentHeading(assignment: Assignment): string {
  const prefix = assignment.kind === 'review' ? 'Revisao da task' : 'Task'
  return `# ${prefix} ${assignment.taskId} — ${assignment.missionId}`
}

export function renderSections(heading: string, sections: readonly PromptSection[]): string {
  const blocks = sections.map((section) => `## ${section.title}\n${section.lines.join('\n')}`)
  return [heading, ...blocks].join('\n\n')
}

/** Contrato tipado -> texto. Um so lugar: os tres adapters usam a mesma traducao. */
export function buildAssignmentPrompt(assignment: Assignment): AssignmentPrompt {
  const heading = assignmentHeading(assignment)
  const sections = assignmentSections(assignment)
  return { heading, sections, text: renderSections(heading, sections) }
}

export function assignmentPromptText(assignment: Assignment): string {
  return buildAssignmentPrompt(assignment).text
}
