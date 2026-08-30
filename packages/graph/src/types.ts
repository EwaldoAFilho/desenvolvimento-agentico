/**
 * Tipos do pacote de grafo. Nos sao `string` opaca: este pacote nao conhece dominio
 * algum (ADR-0001) e por isso nunca interpreta o conteudo de um id.
 */

/** Aresta orientada. `from` precede `to`. */
export interface Edge {
  readonly from: string
  readonly to: string
}

/**
 * Grafo compilado. `nodes` esta em ordem de declaracao — essa ordem e a fonte de
 * desempate de todos os algoritmos, e o que torna cada analise deterministica.
 * As listas de adjacencia tambem sao ordenadas por ordem de declaracao, de modo que
 * o resultado nao depende da ordem em que as arestas foram informadas.
 */
export interface Graph {
  readonly nodes: readonly string[]
  /** Arestas sem duplicatas, ordenadas por (from, to) na ordem de declaracao dos nos. */
  readonly edges: readonly Edge[]
  readonly successors: ReadonlyMap<string, readonly string[]>
  readonly predecessors: ReadonlyMap<string, readonly string[]>
  /** Indice de declaracao de cada no. */
  readonly index: ReadonlyMap<string, number>
}

/** Falha estrutural de construcao. Erro e valor de retorno, nunca excecao. */
export type GraphError =
  | {
      readonly code: 'DUPLICATE_NODE'
      readonly node: string
      readonly message: string
    }
  | {
      readonly code: 'UNKNOWN_NODE'
      readonly node: string
      readonly edge: Edge
      readonly endpoint: 'from' | 'to'
      readonly message: string
    }

export type BuildResult =
  | { readonly ok: true; readonly graph: Graph }
  | { readonly ok: false; readonly errors: readonly GraphError[] }

export type TopologicalResult =
  | { readonly ok: true; readonly order: readonly string[] }
  | {
      readonly ok: false
      /** Nos que nunca ficaram prontos: estao em ciclo ou dependem de um. */
      readonly cycleNodes: readonly string[]
    }

/** Um componente ciclico e um caminho fechado concreto dentro dele. */
export interface Cycle {
  /** Membros do componente fortemente conexo, em ordem de declaracao. */
  readonly nodes: readonly string[]
  /** Caminho fechado, ex.: `['T01', 'T02', 'T03', 'T01']`. */
  readonly path: readonly string[]
}

/** Fecho transitivo consultavel. */
export interface Reachability {
  /** `true` se existe caminho de pelo menos uma aresta de `from` ate `to`. */
  readonly reaches: (from: string, to: string) => boolean
  /** Nos alcancaveis a partir de `from`, em ordem de declaracao. */
  readonly reachable: (from: string) => readonly string[]
}

/** Par de nos sem relacao de ordem, na ordem de declaracao dos dois. */
export type ConcurrentPair = readonly [string, string]

/** Peso de um no. Default: 1 para todos. */
export type Weight = (node: string) => number

export interface LongestPath {
  readonly length: number
  readonly path: readonly string[]
}

export interface NodeSlack {
  readonly es: number
  readonly ef: number
  readonly ls: number
  readonly lf: number
  readonly slack: number
}
