/**
 * Missao GRANDE, gerada: 28 nos em 4 fases, com arestas que atravessam faixas.
 *
 * Existe por uma pergunta so — **o desenho continua legivel quando o DAG cresce?** A
 * EXEMPLO-001 tem 8 tasks e cabe na tela com folga; nenhum problema de rotulo, de
 * sobreposicao ou de custo de layout aparece nesse tamanho. Nada aqui inventa capacidade
 * nova: e a mesma missao, com mais nos.
 *
 * Gerada em vez de versionada porque o conteudo e repetitivo por natureza e o produto nao
 * ganha nada com 28 tasks de mentira dentro de `examples/`. Ela e escrita no projeto-alvo
 * TEMPORARIO, que morre no teardown.
 */

interface PhaseSpec {
  readonly id: string
  readonly title: string
  readonly size: number
}

const PHASES: readonly PhaseSpec[] = [
  { id: 'fundacao', title: 'Fundacao', size: 6 },
  { id: 'dominio', title: 'Dominio', size: 8 },
  { id: 'integracao', title: 'Integracao', size: 8 },
  { id: 'qualidade', title: 'Qualidade', size: 6 },
]

export const LARGE_MISSION_ID = 'GRANDE-001'
export const LARGE_MISSION_FILE = `${LARGE_MISSION_ID}.mission.yaml`
export const LARGE_TASK_COUNT = PHASES.reduce((total, phase) => total + phase.size, 0)
export const LARGE_PHASE_COUNT = PHASES.length

export interface LargeTask {
  readonly id: string
  readonly phase: string
  readonly title: string
  /** Unico por task: `touches` disjunto e o que mantem I2 valido com 28 nos. */
  readonly file: string
  readonly dependencies: readonly string[]
}

/**
 * Cada task depende de duas da fase anterior, com passos diferentes (`i` e `i + 3`): isso
 * cruza as ligacoes em vez de empilhar colunas paralelas — que e justamente o desenho que
 * fica dificil de ler e o motivo desta fixture existir.
 */
export function largeTasks(): readonly LargeTask[] {
  const tasks: LargeTask[] = []
  let previous: string[] = []
  let counter = 0
  for (const phase of PHASES) {
    const current: string[] = []
    for (let index = 0; index < phase.size; index += 1) {
      counter += 1
      const id = `G${String(counter).padStart(2, '0')}`
      const dependencies =
        previous.length === 0
          ? []
          : [
              ...new Set([
                previous[index % previous.length],
                previous[(index + 3) % previous.length],
              ]),
            ]
      tasks.push({
        id,
        phase: phase.id,
        title: `${phase.title} ${index + 1} - modulo gerado ${id}`,
        file: `src/gerado/${id.toLowerCase()}.js`,
        dependencies: dependencies.filter((value): value is string => value !== undefined),
      })
      current.push(id)
    }
    previous = current
  }
  return tasks
}

/** O que o agente de mentira entrega em cada task gerada. Modulo real, importavel. */
export const LARGE_DELIVERIES: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.fromEntries(
    largeTasks().map((task) => [
      task.id,
      { [task.file]: `export const ${task.id.toLowerCase()} = '${task.id}'\n` },
    ]),
  )

function taskBlock(task: LargeTask): string {
  const dependencies = task.dependencies.length === 0 ? '[]' : `[${task.dependencies.join(', ')}]`
  return [
    `  - id: ${task.id}`,
    `    phase: ${task.phase}`,
    `    title: ${task.title}`,
    `    objective: >`,
    `      Entregar ${task.file} como modulo importavel, sem tocar em nenhum outro arquivo.`,
    `    dependencies: ${dependencies}`,
    `    touches:`,
    `      - ${task.file}`,
    `    validation:`,
    `      - ${task.file} exporta ao menos um simbolo`,
    `    gate: unit`,
    `    risk: low`,
    `    estimate: 1`,
  ].join('\n')
}

/**
 * `requireReview: false` e `maxAttempts: 1` de proposito: esta missao existe para o
 * LAYOUT, nao para a governanca — quem exercita revisao, retry e escalonamento e a
 * EXEMPLO-001, com politica de verdade vinda do `project.yaml`.
 */
export function largeMissionYaml(): string {
  const phases = PHASES.map((phase) => `  - id: ${phase.id}\n    title: ${phase.title}`).join('\n')
  const tasks = largeTasks().map(taskBlock).join('\n\n')
  return `apiVersion: agentic/v1
kind: Mission

id: ${LARGE_MISSION_ID}
title: Missao grande para verificar legibilidade do DAG
objective: >
  Exercitar o canvas do DAG com ${LARGE_TASK_COUNT} nos em ${LARGE_PHASE_COUNT} fases,
  com arestas atravessando faixas.

acceptanceCriteria:
  - Cada task gerada entrega o proprio modulo em src/gerado/

defaults:
  requireReview: false
  maxAttempts: 1

phases:
${phases}

tasks:
${tasks}

missionGate: unit
`
}
