import { buildGraph } from '../build.js'
import type { Edge, Graph, Weight } from '../types.js'

export interface GraphSpec {
  readonly nodes: readonly string[]
  readonly edges: readonly Edge[]
}

const e = (from: string, to: string): Edge => ({ from, to })

/** Constroi a fixture; falha alto se a propria fixture for invalida. */
export function graphOf(spec: GraphSpec): Graph {
  const result = buildGraph(spec.nodes, spec.edges)
  if (!result.ok) {
    throw new Error(`fixture invalida: ${result.errors.map((error) => error.message).join('; ')}`)
  }
  return result.graph
}

export const EMPTY: GraphSpec = { nodes: [], edges: [] }

export const SINGLE: GraphSpec = { nodes: ['A'], edges: [] }

/** A -> B -> C -> D */
export const LINEAR: GraphSpec = {
  nodes: ['A', 'B', 'C', 'D'],
  edges: [e('A', 'B'), e('B', 'C'), e('C', 'D')],
}

/** A -> {B, C} -> D */
export const DIAMOND: GraphSpec = {
  nodes: ['A', 'B', 'C', 'D'],
  edges: [e('A', 'B'), e('A', 'C'), e('B', 'D'), e('C', 'D')],
}

/** Duas correntes independentes e um no isolado. */
export const DISCONNECTED: GraphSpec = {
  nodes: ['A', 'B', 'X', 'Y', 'Z'],
  edges: [e('A', 'B'), e('X', 'Y')],
}

/** A -> B -> C -> A */
export const SIMPLE_CYCLE: GraphSpec = {
  nodes: ['A', 'B', 'C'],
  edges: [e('A', 'B'), e('B', 'C'), e('C', 'A')],
}

/** Dois ciclos disjuntos (A/B e C/D) mais um no que aponta para o primeiro. */
export const TWO_CYCLES: GraphSpec = {
  nodes: ['A', 'B', 'C', 'D', 'E'],
  edges: [e('A', 'B'), e('B', 'A'), e('C', 'D'), e('D', 'C'), e('E', 'A')],
}

/** Auto-aresta em A, que tambem precede B. */
export const SELF_LOOP: GraphSpec = {
  nodes: ['A', 'B'],
  edges: [e('A', 'A'), e('A', 'B')],
}

/**
 * Grafo pequeno com caminho critico e folga conferidos a mao:
 * A(2) -> {B(6), C(3)} -> D(4) -> E(1); critico A,B,D,E = 13; folga so em C, igual a 3.
 */
export const PLANNING: GraphSpec = {
  nodes: ['A', 'B', 'C', 'D', 'E'],
  edges: [e('A', 'B'), e('A', 'C'), e('B', 'D'), e('C', 'D'), e('D', 'E')],
}

const PLANNING_WEIGHTS: Record<string, number> = { A: 2, B: 6, C: 3, D: 4, E: 1 }

export const planningWeight: Weight = (node) => PLANNING_WEIGHTS[node] ?? 0

/**
 * O DAG da missao DA-CORE-001 (docs/development/MVP-PLAN.md secoes 3 a 6), na ordem de
 * declaracao da tabela de tasks. Serve de oraculo: caminho critico, folgas e ondas estao
 * publicados no documento e sao conferidos pelos testes.
 */
export const MVP: GraphSpec = {
  nodes: [
    'T01',
    'T02',
    'T03',
    'T04',
    'T05',
    'T16',
    'T06',
    'T07',
    'T08',
    'T17',
    'T09',
    'T10',
    'T11',
    'T12',
    'T13',
    'T14',
    'T15',
  ],
  edges: [
    e('T01', 'T02'),
    e('T01', 'T04'),
    e('T01', 'T16'),
    e('T02', 'T03'),
    e('T02', 'T06'),
    e('T02', 'T08'),
    e('T02', 'T17'),
    e('T03', 'T05'),
    e('T03', 'T07'),
    e('T03', 'T14'),
    e('T04', 'T05'),
    e('T16', 'T07'),
    e('T16', 'T17'),
    e('T17', 'T09'),
    e('T05', 'T10'),
    e('T05', 'T12'),
    e('T06', 'T11'),
    e('T07', 'T11'),
    e('T08', 'T11'),
    e('T09', 'T11'),
    e('T10', 'T11'),
    e('T11', 'T12'),
    e('T11', 'T13'),
    e('T12', 'T15'),
    e('T13', 'T15'),
    e('T14', 'T15'),
  ],
}

const MVP_ESTIMATES: Record<string, number> = {
  T01: 2,
  T02: 6,
  T03: 4,
  T04: 3,
  T05: 5,
  T16: 3,
  T06: 5,
  T07: 3,
  T08: 6,
  T17: 5,
  T09: 7,
  T10: 4,
  T11: 9,
  T12: 4,
  T13: 5,
  T14: 7,
  T15: 5,
}

export const mvpEstimate: Weight = (node) => MVP_ESTIMATES[node] ?? 0
