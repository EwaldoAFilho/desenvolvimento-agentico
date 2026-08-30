import type { RunGraphDto } from '@agentic/schemas'
import dagre from 'dagre'

/**
 * Agrupamento do canvas. Fases servem a leitura, nao a ordem (DASHBOARD 4); ondas vem do
 * contrato (`graph.waves`, earliest start) e nunca sao recalculadas aqui.
 */
export type Grouping = 'phase' | 'wave' | 'topological'

export const GROUPINGS: readonly Grouping[] = ['phase', 'wave', 'topological']

export const GROUPING_LABEL: Record<Grouping, string> = {
  phase: 'por fase',
  wave: 'por onda',
  topological: 'topológico',
}

export const NODE_WIDTH = 224
export const NODE_HEIGHT = 84

const GAP_X = 40
const BAND_PADDING_TOP = 34
const BAND_PADDING_BOTTOM = 22
const BAND_HEIGHT = NODE_HEIGHT + BAND_PADDING_TOP + BAND_PADDING_BOTTOM
const MARGIN_X = 32
const MARGIN_Y = 24

export interface LayoutNode {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly band: number
}

export interface LayoutBand {
  readonly key: string
  readonly label: string
  readonly index: number
  readonly y: number
  readonly height: number
}

export interface DagLayout {
  readonly grouping: Grouping
  readonly nodes: readonly LayoutNode[]
  readonly bands: readonly LayoutBand[]
  readonly width: number
  readonly height: number
}

/**
 * Ordem declarada das fases: a primeira aparicao em `graph.nodes`. A estrutura vem da missao
 * compilada; o cliente so a le.
 */
export function phaseOrder(graph: RunGraphDto): readonly string[] {
  const seen: string[] = []
  for (const node of graph.nodes) {
    if (!seen.includes(node.phase)) seen.push(node.phase)
  }
  return seen
}

interface DagrePosition {
  readonly x: number
  readonly y: number
}

/** dagre resolve a ordenacao (minimiza cruzamentos); as faixas apenas fixam o `y`. */
function runDagre(graph: RunGraphDto): Map<string, DagrePosition> {
  const g = new dagre.graphlib.Graph({ multigraph: false, compound: false })
  g.setGraph({ rankdir: 'TB', nodesep: GAP_X, ranksep: BAND_PADDING_TOP + BAND_PADDING_BOTTOM })
  g.setDefaultEdgeLabel(() => ({}))
  for (const node of graph.nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  for (const edge of graph.edges) {
    g.setEdge(edge.from, edge.to)
  }
  dagre.layout(g)
  const positions = new Map<string, DagrePosition>()
  for (const node of graph.nodes) {
    const laid = g.node(node.id) as { x?: number; y?: number } | undefined
    positions.set(node.id, { x: laid?.x ?? 0, y: laid?.y ?? 0 })
  }
  return positions
}

function bandKeysFor(graph: RunGraphDto, grouping: Grouping): Map<string, number> {
  const bandOf = new Map<string, number>()
  if (grouping === 'phase') {
    const order = phaseOrder(graph)
    for (const node of graph.nodes) {
      bandOf.set(node.id, Math.max(0, order.indexOf(node.phase)))
    }
    return bandOf
  }
  graph.waves.forEach((wave, index) => {
    for (const id of wave) bandOf.set(id, index)
  })
  for (const node of graph.nodes) {
    if (!bandOf.has(node.id)) bandOf.set(node.id, 0)
  }
  return bandOf
}

function bandLabels(graph: RunGraphDto, grouping: Grouping): readonly string[] {
  if (grouping === 'phase') return phaseOrder(graph)
  return graph.waves.map((_, index) => `onda ${index + 1}`)
}

/**
 * Empacota em faixa preservando a ordem horizontal do dagre: nenhum par de caixas se
 * sobrepoe, e a leitura da esquerda para a direita continua a que o dagre escolheu.
 */
function packBand(
  ids: readonly string[],
  positions: Map<string, DagrePosition>,
): Map<string, number> {
  const sorted = [...ids].sort((a, b) => {
    const ax = positions.get(a)?.x ?? 0
    const bx = positions.get(b)?.x ?? 0
    return ax === bx ? a.localeCompare(b) : ax - bx
  })
  const x = new Map<string, number>()
  let cursor = MARGIN_X
  for (const id of sorted) {
    const wanted = (positions.get(id)?.x ?? 0) - NODE_WIDTH / 2
    const placed = Math.max(cursor, wanted)
    x.set(id, placed)
    cursor = placed + NODE_WIDTH + GAP_X
  }
  return x
}

function layoutBanded(graph: RunGraphDto, grouping: Grouping): DagLayout {
  const positions = runDagre(graph)
  const bandOf = bandKeysFor(graph, grouping)
  const labels = bandLabels(graph, grouping)
  const byBand = new Map<number, string[]>()
  for (const node of graph.nodes) {
    const band = bandOf.get(node.id) ?? 0
    const bucket = byBand.get(band)
    if (bucket === undefined) byBand.set(band, [node.id])
    else bucket.push(node.id)
  }

  const nodes: LayoutNode[] = []
  const bands: LayoutBand[] = []
  let maxRight = 0
  const usedBands = [...byBand.keys()].sort((a, b) => a - b)
  usedBands.forEach((band, position) => {
    const ids = byBand.get(band) ?? []
    const bandY = MARGIN_Y + position * BAND_HEIGHT
    bands.push({
      key: labels[band] ?? `faixa ${band + 1}`,
      label: labels[band] ?? `faixa ${band + 1}`,
      index: position,
      y: bandY,
      height: BAND_HEIGHT,
    })
    const xs = packBand(ids, positions)
    for (const id of ids) {
      const x = xs.get(id) ?? MARGIN_X
      nodes.push({
        id,
        x,
        y: bandY + BAND_PADDING_TOP,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        band: position,
      })
      maxRight = Math.max(maxRight, x + NODE_WIDTH)
    }
  })

  nodes.sort((a, b) => a.id.localeCompare(b.id))
  return {
    grouping,
    nodes,
    bands,
    width: maxRight + MARGIN_X,
    height: MARGIN_Y + usedBands.length * BAND_HEIGHT + MARGIN_Y,
  }
}

function layoutTopological(graph: RunGraphDto): DagLayout {
  const positions = runDagre(graph)
  const nodes: LayoutNode[] = graph.nodes
    .map((node) => {
      const at = positions.get(node.id) ?? { x: 0, y: 0 }
      return {
        id: node.id,
        x: at.x - NODE_WIDTH / 2 + MARGIN_X,
        y: at.y - NODE_HEIGHT / 2 + MARGIN_Y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        band: 0,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  const width = nodes.reduce((acc, node) => Math.max(acc, node.x + node.width), 0) + MARGIN_X
  const height = nodes.reduce((acc, node) => Math.max(acc, node.y + node.height), 0) + MARGIN_Y
  return { grouping: 'topological', nodes, bands: [], width, height }
}

/**
 * Geometria pura: depende **apenas** de `graph` (congelado no inicio do run) e do
 * agrupamento. Nenhum estado de task entra aqui — por isso o no nao dança a cada evento
 * (DASHBOARD 6).
 */
export function layoutDag(graph: RunGraphDto, grouping: Grouping = 'phase'): DagLayout {
  return grouping === 'topological' ? layoutTopological(graph) : layoutBanded(graph, grouping)
}

export function boxesOverlap(a: LayoutNode, b: LayoutNode): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}
