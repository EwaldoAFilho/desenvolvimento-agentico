import {
  type MissionSpec,
  type PathScope,
  resolveReviewPolicy,
  type TaskId,
  type TaskSpec,
} from '@agentic/domain'
import { predecessorsOf, successorsOf } from '@agentic/graph'
import type { ProjectFile } from '@agentic/schemas'
import { type Analysis, DEFAULT_ESTIMATE, maxParallelism } from './analysis.js'
import { diagnostic } from './diagnostics.js'
import { isTopLevelDirectory } from './paths.js'
import type { Locate } from './sources.js'
import type { Diagnostic, TouchConflict } from './types.js'

/**
 * Limiares das heuristicas DA2003/DA2004. Ficam explicitos e exportados porque heuristica
 * escondida vira magica: o humano precisa saber por que a task foi apontada (ARCHITECTURE 7.3).
 */
export const HEURISTICS = {
  /** Quantos escopos ja tornam `touches` amplo. */
  broadTouchCount: 5,
  /** `estimate` a partir do qual a task e considerada grande. */
  largeEstimate: 8,
  /** Virgulas e ponto-e-virgulas no objective que indicam objetivo multi-clausula. */
  multiClauseSeparators: 3,
  /** `estimate` ate o qual a task e microtask. */
  microEstimate: 1,
  /** Quantos escopos ainda contam como escopo minimo. */
  microTouchCount: 1,
  /** Tamanho minimo da cadeia linear de microtasks para virar DA2004. */
  minFragmentedChain: 3,
} as const

export interface HeuristicInput {
  readonly spec: MissionSpec
  readonly project: ProjectFile
  readonly analysis: Analysis
  readonly touchConflicts: readonly TouchConflict[]
  readonly locateMission: Locate
}

const estimateOf = (task: TaskSpec): number => task.estimate ?? DEFAULT_ESTIMATE

const isBroadScope = (touches: readonly PathScope[]): boolean =>
  touches.length >= HEURISTICS.broadTouchCount || touches.some(isTopLevelDirectory)

function clauseCount(objective: string): number {
  return (objective.match(/[,;]/g) ?? []).length
}

function isMicroTask(task: TaskSpec): boolean {
  return (
    task.gate === undefined &&
    estimateOf(task) <= HEURISTICS.microEstimate &&
    task.touches.length <= HEURISTICS.microTouchCount
  )
}

/**
 * Cadeias lineares maximas de microtasks: cada elo tem exatamente um predecessor e um
 * sucessor dentro da cadeia. Percorre em ordem de declaracao, entao o resultado e estavel.
 */
function fragmentedChains(spec: MissionSpec, analysis: Analysis): TaskId[][] {
  const micro = new Set<string>(spec.tasks.filter(isMicroTask).map((task) => task.id))
  const graph = analysis.graph
  const isContinuation = (id: string): boolean => {
    const predecessors = predecessorsOf(graph, id)
    const only = predecessors[0]
    return (
      predecessors.length === 1 &&
      only !== undefined &&
      micro.has(only) &&
      successorsOf(graph, only).length === 1
    )
  }

  const chains: TaskId[][] = []
  for (const node of graph.nodes) {
    if (!micro.has(node) || isContinuation(node)) continue
    const chain: string[] = [node]
    let cursor = node
    for (;;) {
      const successors = successorsOf(graph, cursor)
      const next = successors[0]
      if (successors.length !== 1 || next === undefined) break
      if (!micro.has(next) || predecessorsOf(graph, next).length !== 1) break
      chain.push(next)
      cursor = next
    }
    if (chain.length >= HEURISTICS.minFragmentedChain) chains.push(chain as TaskId[])
  }
  return chains
}

function reviewerCapableProviders(project: ProjectFile): string[] {
  return Object.entries(project.providers.registry)
    .filter(([, config]) => config.roles.includes('reviewer'))
    .map(([id]) => id)
    .sort()
}

/**
 * Analises que avisam sem impedir (ARCHITECTURE 7.1: DA2xxx e DA3xxx). O compilador
 * sinaliza e explica; nao decompoe, nao funde e nao reordena nada (P15).
 */
export function heuristicDiagnostics(input: HeuristicInput): Diagnostic[] {
  const { spec, project, analysis, touchConflicts, locateMission } = input
  const diagnostics: Diagnostic[] = []
  const indexOfTask = new Map<string, number>()
  spec.tasks.forEach((task, index) => {
    if (!indexOfTask.has(task.id)) indexOfTask.set(task.id, index)
  })
  const at = (id: string, field?: string) => {
    const index = indexOfTask.get(id)
    if (index === undefined) return {}
    return locateMission(field === undefined ? ['tasks', index] : ['tasks', index, field])
  }

  for (const conflict of touchConflicts) {
    const pairs = conflict.paths.map((item) => `${item.left} × ${item.right}`).join(', ')
    diagnostics.push(
      diagnostic('DA2001', {
        message: `${conflict.tasks[0]} e ${conflict.tasks[1]} podem rodar juntas e escrevem no mesmo escopo (${pairs})`,
        targets: [conflict.tasks[0], conflict.tasks[1]],
        at: at(conflict.tasks[0], 'touches'),
      }),
    )
  }

  const phaseRank = new Map<string, number>()
  spec.phases.forEach((phase, index) => {
    phaseRank.set(String(phase.id), phase.order ?? index)
  })
  const ranks = [...phaseRank.values()]
  const firstRank = ranks.length === 0 ? 0 : Math.min(...ranks)

  for (const task of spec.tasks) {
    if (task.gate === undefined && task.validation.length === 0) {
      diagnostics.push(
        diagnostic('DA2002', {
          message: `task ${task.id} nao tem gate nem validation: nao ha como verificar que terminou`,
          targets: [task.id],
          at: at(task.id),
        }),
      )
    }

    const broad = isBroadScope(task.touches)
    if (
      broad &&
      clauseCount(task.objective) >= HEURISTICS.multiClauseSeparators &&
      estimateOf(task) >= HEURISTICS.largeEstimate
    ) {
      diagnostics.push(
        diagnostic('DA2003', {
          message: `task ${task.id} acumula escopo amplo, objetivo multi-clausula e estimate ${estimateOf(task)}`,
          targets: [task.id],
          at: at(task.id),
        }),
      )
    }

    for (const touch of task.touches) {
      if (!isTopLevelDirectory(touch)) continue
      diagnostics.push(
        diagnostic('DA2005', {
          message: `task ${task.id} declara ${touch}, um diretorio de topo inteiro`,
          targets: [task.id, String(touch)],
          at: at(task.id, 'touches'),
        }),
      )
    }

    if (analysis.dependents(task.id).length === 0 && task.gate !== spec.missionGate) {
      diagnostics.push(
        diagnostic('DA2006', {
          message: `task ${task.id} nao tem dependentes e nao e coberta pelo mission gate`,
          targets: [task.id],
          at: at(task.id),
        }),
      )
    }

    const requireReview = task.requireReview ?? project.policies.requireReviewByDefault
    if (requireReview === false && task.risk === 'high') {
      diagnostics.push(
        diagnostic('DA2007', {
          message: `task ${task.id} tem risk high e requireReview false`,
          targets: [task.id],
          at: at(task.id, 'requireReview'),
        }),
      )
    }

    const rank = phaseRank.get(task.phase)
    if (rank !== undefined && rank > firstRank) {
      const earlier = task.dependencies.some((dependency) => {
        const other = analysis.tasksById.get(dependency)
        const otherRank = other === undefined ? undefined : phaseRank.get(other.phase)
        return otherRank !== undefined && otherRank < rank
      })
      if (!earlier) {
        diagnostics.push(
          diagnostic('DA3001', {
            message: `task ${task.id} esta na fase ${task.phase} e nao depende de nenhuma task de fase anterior`,
            targets: [task.id, task.phase],
            at: at(task.id, 'dependencies'),
          }),
        )
      }
    }
  }

  for (const chain of fragmentedChains(spec, analysis)) {
    diagnostics.push(
      diagnostic('DA2004', {
        message: `cadeia linear de microtasks sem gate: ${chain.join(' → ')}`,
        targets: [...chain],
        at: at(String(chain[0])),
      }),
    )
  }

  const crossRequired = spec.tasks
    .filter(
      (task) =>
        resolveReviewPolicy({
          task: { reviewPolicy: task.reviewPolicy, risk: task.risk },
          missionDefaults: spec.defaults,
          projectPolicy: {
            byRisk: project.policies.review.byRisk,
            default: project.policies.review.default,
          },
        }).policy === 'cross-provider-required',
    )
    .map((task) => task.id)
  const reviewers = reviewerCapableProviders(project)
  if (crossRequired.length > 0 && reviewers.length < 2) {
    diagnostics.push(
      diagnostic('DA2008', {
        message: `${crossRequired.length} task(s) exigem cross-provider-required e o projeto tem ${reviewers.length} provider(s) apto(s) a revisar`,
        targets: [...crossRequired],
        at: at(String(crossRequired[0])),
      }),
    )
  }

  if (spec.tasks.length > 1 && maxParallelism(analysis) <= 1) {
    diagnostics.push(
      diagnostic('DA3002', {
        message: `o plano e uma cadeia linear de ${spec.tasks.length} tasks: nao ha paralelismo a explorar`,
        targets: [String(spec.id)],
        at: locateMission(['tasks']),
      }),
    )
  }

  return diagnostics
}
