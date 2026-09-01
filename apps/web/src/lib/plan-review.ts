import type {
  CompileReportDto,
  DiagnosticDto,
  DiagnosticSeverity,
  GraphNodeDto,
  RunGraphDto,
  RunPoliciesDto,
  TaskDetail,
} from '@agentic/schemas'

/**
 * Regras da revisao do plano que nao dependem de React. Ficam aqui as leituras com as quais o
 * humano decide: o que o compilador contou, onde duas tasks se atropelam e — o que importa
 * mais — o limite do que a tela pode afirmar sobre revisao antes de existir tentativa.
 */

export function bySeverity(
  report: CompileReportDto,
  severity: DiagnosticSeverity,
): readonly DiagnosticDto[] {
  return report.diagnostics.filter((diagnostic) => diagnostic.severity === severity)
}

/**
 * Conflito e choque ENTRE tasks, nao defeito de uma task sozinha. Sao os diagnosticos que
 * citam mais de um lado do plano: escopo sobreposto entre concorrentes — o que I2 proibe em
 * execucao — e dependencia que se fecha sobre si mesma. `touches amplo demais` ou `task sem
 * validacao` sao avisos da task, e ja aparecem na lista de avisos: repeti-los aqui esvaziaria
 * a palavra conflito.
 */
const CONFLICT_KINDS: Readonly<Record<string, string>> = {
  DA1004: 'dependência — a task espera por si mesma',
  DA1005: 'dependência — ciclo entre tasks',
  DA2001: 'escopo — tasks concorrentes escrevem no mesmo caminho',
}

export function conflictKindOf(code: string): string | undefined {
  return CONFLICT_KINDS[code]
}

export function conflictsOf(report: CompileReportDto): readonly DiagnosticDto[] {
  return report.diagnostics.filter((diagnostic) => conflictKindOf(diagnostic.code) !== undefined)
}

/**
 * Os numeros do compilador numa linha so. Avisos e erros saem da CONTAGEM dos diagnosticos, e
 * nao de `stats`: e a mesma lista que a tela mostra logo abaixo, e duas fontes para o mesmo
 * numero divergem exatamente no caso em que a divergencia importa.
 */
export function planStatsLine(report: CompileReportDto): string {
  const stats = report.stats
  const warnings = bySeverity(report, 'WARNING').length
  const errors = bySeverity(report, 'ERROR').length
  return (
    `${stats.tasks} tasks · ${stats.phases} fases · caminho crítico ${stats.criticalPathLength} tasks` +
    ` · ${stats.waves} ondas · paralelismo máximo ${stats.maxParallelism} · ${warnings} avisos` +
    ` · ${errors} erros · ${conflictsOf(report).length} conflitos`
  )
}

/** O que o compilador apontou NESTA task: o no do plano carrega o proprio diagnostico. */
export function diagnosticsFor(report: CompileReportDto, taskId: string): readonly DiagnosticDto[] {
  return report.diagnostics.filter((diagnostic) => diagnostic.targets.includes(taskId))
}

/** Quem espera por esta task. Sai das arestas do grafo congelado, nao de suposicao. */
export function dependentsOf(graph: RunGraphDto, taskId: string): readonly string[] {
  return graph.edges.filter((edge) => edge.from === taskId).map((edge) => edge.to)
}

export const RISK_LABEL: Readonly<Record<GraphNodeDto['risk'], string>> = {
  low: 'baixo',
  medium: 'médio',
  high: 'alto',
}

/**
 * O que a tela pode dizer sobre revisao ANTES de existir tentativa. A politica APLICADA e fato
 * medido pelo control plane e so nasce com a tentativa — I10 exige que o rebaixamento seja
 * visivel, e ele so existe depois de despachar.
 *
 * Antes disso a tela mostra o que a TASK DECLARA, que agora vem no no do grafo. Dizer apenas
 * o teto de revisores do run tornava indistinguiveis, na inspecao do plano, uma task que
 * exige revisor de outro fornecedor e outra que dispensa revisao — justamente onde o humano
 * decide se aprova. Declarado e declarado; aplicado continua sendo so o que foi medido.
 */
export function reviewReadingOf(
  detail: TaskDetail | undefined,
  policies: RunPoliciesDto,
  node?: { readonly requireReview?: boolean; readonly reviewPolicy?: string },
): string {
  const policy = detail?.review.policy
  if (policy !== undefined) {
    const downgraded = detail?.review.policyOutcome === 'downgraded'
    return `${policy}${downgraded ? ' — rebaixada nesta tentativa' : ' — aplicada'}`
  }
  const declarada =
    node?.reviewPolicy === undefined ? undefined : `a task declara ${node.reviewPolicy}`
  if (node?.requireReview === false) {
    // O schema aceita `requireReview: false` COM `reviewPolicy` declarada. Sair cedo
    // esconderia a politica e faria o no parecer mais simples do que e — e o humano decide
    // aprovar olhando exatamente isto.
    return declarada === undefined
      ? 'a task declara que não exige revisão independente'
      : `a task declara que não exige revisão independente, mas ${declarada}`
  }
  const capacity =
    policies.maxReviewers === 0
      ? 'este run não admite revisor: nenhuma revisão será despachada'
      : `este run admite até ${policies.maxReviewers} revisor(es) em paralelo`
  const exige = node?.requireReview === true ? 'revisão exigida' : undefined
  const partes = [exige, declarada].filter((parte) => parte !== undefined)
  const prefixo = partes.length > 0 ? `${partes.join('; ')} — ` : ''
  return `${prefixo}a política aplicada é registrada na tentativa, e nenhuma aconteceu — ${capacity}`
}
