import type { MissionSpec, TaskId } from '@agentic/domain'
import { toMissionSpec } from '@agentic/schemas'
import { analyze, DEFAULT_ESTIMATE, touchConflictsOf } from './analysis.js'
import { diagnostic, hasError, sortDiagnostics } from './diagnostics.js'
import { specHashOf } from './hash.js'
import { heuristicDiagnostics } from './heuristics.js'
import { semanticDiagnostics } from './semantics.js'
import { parseGatesSource, parseMissionSource, parseProjectSource } from './sources.js'
import type {
  CompiledGraph,
  CompiledNode,
  CompileInput,
  CompileResult,
  Diagnostic,
} from './types.js'

function failed(diagnostics: readonly Diagnostic[]): CompileResult {
  return { diagnostics: sortDiagnostics(diagnostics) }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Pipeline de ARCHITECTURE 7: parse -> schema -> semantica -> grafo -> analises.
 *
 * Recebe o CONTEUDO dos tres arquivos, nunca caminhos. Nunca lanca: falha e valor de
 * retorno. `graph` so existe quando nao sobrou nenhum ERROR — e a regra "ERROR impede
 * compilar"; WARNING compila e fica registrado no proprio grafo.
 */
export function compileMission(input: CompileInput): CompileResult {
  try {
    return run(input)
  } catch (error) {
    // Defesa de fronteira: o contrato e nao lancar, mesmo diante de um documento
    // que atravesse o schema e quebre a traducao para o dominio.
    return failed([
      diagnostic('DA1001', {
        message: `mission.yaml nao pode ser interpretado: ${messageOf(error)}`,
        targets: ['mission'],
      }),
    ])
  }
}

function run(input: CompileInput): CompileResult {
  const mission = parseMissionSource(input.missionText)
  const project = parseProjectSource(input.projectFile)
  const gates = parseGatesSource(input.gatesFile)
  const parseDiagnostics = [...mission.diagnostics, ...project.diagnostics, ...gates.diagnostics]

  const missionFile = mission.value
  const projectFile = project.value
  const gatesFile = gates.value
  if (missionFile === undefined || projectFile === undefined || gatesFile === undefined) {
    return failed(parseDiagnostics)
  }

  let spec: MissionSpec
  try {
    spec = toMissionSpec(missionFile)
  } catch (error) {
    return failed([
      ...parseDiagnostics,
      diagnostic('DA1001', {
        message: `mission.yaml nao vira MissionSpec: ${messageOf(error)}`,
        targets: ['mission'],
      }),
    ])
  }

  const analysis = analyze(spec)
  const semantic = semanticDiagnostics({
    spec,
    project: projectFile,
    gates: gatesFile,
    analysis,
    locateMission: mission.locate,
    locateProject: project.locate,
  })

  const structural = [...parseDiagnostics, ...semantic]
  // Com ERROR o plano nao e analisavel: waves, concorrencia e caminho critico sairiam
  // de um grafo que nao existe. Recusa e explica; nao adivinha o plano pretendido.
  if (hasError(structural)) return failed(structural)

  const touchConflicts = touchConflictsOf(analysis)
  const heuristic = heuristicDiagnostics({
    spec,
    project: projectFile,
    analysis,
    touchConflicts,
    locateMission: mission.locate,
  })
  const diagnostics = sortDiagnostics([...structural, ...heuristic])

  const nodes: CompiledNode[] = spec.tasks.map((task) => ({
    task,
    dependents: analysis.dependents(task.id),
    depth: analysis.depth.get(task.id) ?? 0,
  }))

  const graph: CompiledGraph = {
    specHash: specHashOf(spec),
    missionId: spec.id,
    nodes,
    edges: analysis.edges,
    topologicalOrder: analysis.topological,
    waves: analysis.waves,
    criticalPath: analysis.criticalPath,
    concurrencyMatrix: analysis.concurrent,
    touchConflicts,
    diagnostics,
  }
  return { graph, diagnostics }
}

/** Tasks do grafo compilado, na ordem de declaracao. */
export function compiledTasks(graph: CompiledGraph): readonly TaskId[] {
  return graph.nodes.map((node) => node.task.id)
}

/** Soma dos `estimate` de todas as tasks: o trabalho total do plano. */
export function totalWork(graph: CompiledGraph): number {
  return graph.nodes.reduce((sum, node) => sum + (node.task.estimate ?? DEFAULT_ESTIMATE), 0)
}
