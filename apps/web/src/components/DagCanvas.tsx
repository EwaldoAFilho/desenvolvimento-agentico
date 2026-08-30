import type { RunSnapshot } from '@agentic/schemas'
import { Background, Controls, type Edge, type Node, ReactFlow } from '@xyflow/react'
import { type JSX, type KeyboardEvent, useCallback, useMemo } from 'react'
import {
  type DagLayout,
  GROUPING_LABEL,
  GROUPINGS,
  type Grouping,
  layoutDag,
  NODE_HEIGHT,
} from '../lib/dag-layout.js'
import { classifyEdge, criticalPathEdges, EDGE_LABEL, edgeKey } from '../lib/edges.js'
import type { TaskStatus } from '../lib/status.js'
import { BandNode, type BandNodeData } from './BandNode.js'
import { TaskNode, type TaskNodeData } from './TaskNode.js'

const nodeTypes = { task: TaskNode, band: BandNode }

export interface DagCanvasProps {
  readonly snapshot: RunSnapshot
  readonly grouping: Grouping
  readonly onGroupingChange: (grouping: Grouping) => void
  readonly selectedTaskId?: string
  readonly onSelectTask: (taskId: string) => void
}

function buildNodes(
  snapshot: RunSnapshot,
  layout: DagLayout,
  selectedTaskId: string | undefined,
): Node[] {
  const statusOf = new Map<string, TaskStatus>(snapshot.tasks.map((t) => [t.id, t.status]))
  const attemptOf = new Map<string, number>(snapshot.tasks.map((t) => [t.id, t.attemptCount]))
  const durationOf = new Map<string, number | undefined>(
    snapshot.tasks.map((t) => [t.id, t.durationMs]),
  )
  const critical = new Set(snapshot.graph.criticalPath)
  const titleOf = new Map(snapshot.graph.nodes.map((n) => [n.id, n]))

  const bands: Node[] = layout.bands.map((band) => ({
    id: `band:${band.index}`,
    type: 'band',
    position: { x: 0, y: band.y },
    data: { label: band.label, width: layout.width, height: band.height } satisfies BandNodeData,
    draggable: false,
    selectable: false,
    focusable: false,
    zIndex: 0,
    style: { width: layout.width, height: band.height },
  }))

  const tasks: Node[] = layout.nodes.map((laid) => {
    const spec = titleOf.get(laid.id)
    const data: TaskNodeData = {
      taskId: laid.id,
      title: spec?.title ?? laid.id,
      phase: spec?.phase ?? '—',
      status: statusOf.get(laid.id) ?? 'PENDING',
      attempt: attemptOf.get(laid.id) ?? 0,
      maxAttempts: snapshot.run.policies.defaultMaxAttempts,
      durationMs: durationOf.get(laid.id),
      onCriticalPath: critical.has(laid.id),
      picked: laid.id === selectedTaskId,
    }
    return {
      id: laid.id,
      type: 'task',
      position: { x: laid.x, y: laid.y },
      data,
      draggable: false,
      connectable: false,
      width: laid.width,
      height: NODE_HEIGHT,
      zIndex: 1,
    }
  })

  return [...bands, ...tasks]
}

export function buildEdges(snapshot: RunSnapshot): Edge[] {
  const statusOf = new Map<string, TaskStatus>(snapshot.tasks.map((t) => [t.id, t.status]))
  const critical = criticalPathEdges(snapshot.graph)
  return snapshot.graph.edges.map((edge) => {
    const kind = classifyEdge(
      statusOf.get(edge.from) ?? 'PENDING',
      statusOf.get(edge.to) ?? 'PENDING',
    )
    const key = edgeKey(edge)
    const onCritical = critical.has(key)
    return {
      id: key,
      source: edge.from,
      target: edge.to,
      type: 'smoothstep',
      className: `dag-edge dag-edge--${kind}${onCritical ? ' dag-edge--critical' : ''}`,
      ariaLabel: `${edge.from} para ${edge.to}: ${EDGE_LABEL[kind]}${
        onCritical ? ', caminho crítico' : ''
      }`,
      data: { kind, onCritical },
      style: { strokeWidth: onCritical ? 3.5 : 1.6 },
    }
  })
}

/**
 * A **estrutura** vem de `snapshot.graph` (missao compilada, congelada) e o **estado visual**
 * vem de `snapshot.tasks`. Um e geometria, o outro e cor: por isso o no nao dança a cada
 * evento (DASHBOARD 6).
 */
export function DagCanvas({
  snapshot,
  grouping,
  onGroupingChange,
  selectedTaskId,
  onSelectTask,
}: DagCanvasProps): JSX.Element {
  const layout = useMemo(() => layoutDag(snapshot.graph, grouping), [snapshot.graph, grouping])
  const nodes = useMemo(
    () => buildNodes(snapshot, layout, selectedTaskId),
    [snapshot, layout, selectedTaskId],
  )
  const edges = useMemo(() => buildEdges(snapshot), [snapshot])

  const handleNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      if (node.type === 'task') onSelectTask(node.id)
    },
    [onSelectTask],
  )

  // Enter/Espaco sobre o no selecionam pelo teclado: `onNodeClick` so cobre o mouse.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const target = event.target as HTMLElement | null
      const node = target?.closest('.react-flow__node-task')
      const id = node?.getAttribute('data-id')
      if (id !== null && id !== undefined && id.length > 0) onSelectTask(id)
    },
    [onSelectTask],
  )

  return (
    <section className="dag" aria-label="Canvas do DAG">
      <div className="dag__toolbar">
        <span className="dag__toolbar-label">agrupar</span>
        {GROUPINGS.map((option) => (
          <button
            key={option}
            type="button"
            className={`chip${option === grouping ? ' chip--on' : ''}`}
            aria-pressed={option === grouping}
            onClick={() => onGroupingChange(option)}
          >
            {GROUPING_LABEL[option]}
          </button>
        ))}
      </div>
      {/** biome-ignore lint/a11y/noStaticElementInteractions: o alvo focavel e o no do react-flow, que ja tem role e tabindex; aqui so ouvimos a tecla. */}
      <div className="dag__canvas" data-testid="dag-canvas" onKeyDown={handleKeyDown}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={handleNodeClick}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          fitView
          minZoom={0.2}
          maxZoom={1.6}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </section>
  )
}
