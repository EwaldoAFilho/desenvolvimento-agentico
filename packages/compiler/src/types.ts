import type {
  Dependency,
  DiagnosticSeverity,
  MissionId,
  PathScopeConflict,
  TaskId,
  TaskSpec,
} from '@agentic/domain'

/**
 * Catalogo fechado (ARCHITECTURE 7.1). Codigo novo exige documento novo: o compilador
 * nao inventa diagnostico em runtime.
 */
export const DIAGNOSTIC_CODES = [
  'DA1000',
  'DA1001',
  'DA1002',
  'DA1003',
  'DA1004',
  'DA1005',
  'DA1006',
  'DA1007',
  'DA1008',
  'DA1009',
  'DA1010',
  'DA1011',
  'DA2001',
  'DA2002',
  'DA2003',
  'DA2004',
  'DA2005',
  'DA2006',
  'DA2007',
  'DA2008',
  'DA3001',
  'DA3002',
] as const

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number]

/**
 * `targets` cita as entidades envolvidas: o primeiro elemento e o dono do problema (id da
 * task, id da missao ou referencia de campo como `project.execution.workspace`) e os
 * demais sao as referencias citadas (a dependencia inexistente, o gate ausente, o par).
 */
export interface Diagnostic {
  readonly code: DiagnosticCode
  readonly severity: DiagnosticSeverity
  readonly message: string
  readonly targets: readonly string[]
  readonly line?: number
  readonly column?: number
  readonly hint?: string
}

/** Task com os indices derivados do grafo (DOMAIN-MODEL 2.6). */
export interface CompiledNode {
  readonly task: TaskSpec
  /** Tasks que dependem desta, em ordem de declaracao. */
  readonly dependents: readonly TaskId[]
  /** Maior distancia em arestas ate uma origem — o indice da wave do no. */
  readonly depth: number
}

export interface CriticalPath {
  readonly tasks: readonly TaskId[]
  /** Soma dos `estimate` do caminho: o menor tempo possivel do plano. */
  readonly length: number
}

/** Par sem relacao de ordem, na ordem de declaracao das duas tasks. */
export type ConcurrentTaskPair = readonly [TaskId, TaskId]

export interface TouchConflict {
  readonly tasks: ConcurrentTaskPair
  readonly paths: readonly PathScopeConflict[]
}

/** Produto do compilador: imutavel, deterministico, serializavel e hasheavel (ADR-0005). */
export interface CompiledGraph {
  readonly specHash: string
  readonly missionId: MissionId
  readonly nodes: readonly CompiledNode[]
  readonly edges: readonly Dependency[]
  readonly topologicalOrder: readonly TaskId[]
  readonly waves: readonly (readonly TaskId[])[]
  readonly criticalPath: CriticalPath
  readonly concurrencyMatrix: readonly ConcurrentTaskPair[]
  readonly touchConflicts: readonly TouchConflict[]
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * Os tres campos sao CONTEUDO de arquivo, nunca caminho: o pacote e puro e nao le disco
 * (ARCHITECTURE 2). Quem le o arquivo e a interface.
 */
export interface CompileInput {
  readonly missionText: string
  readonly projectFile: string
  readonly gatesFile: string
}

/** `graph` so existe quando nao ha nenhum ERROR. WARNING compila e fica registrado. */
export interface CompileResult {
  readonly graph?: CompiledGraph
  readonly diagnostics: readonly Diagnostic[]
}
