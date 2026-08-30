import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import type { CSSProperties, JSX } from 'react'
import { formatDuration, truncate } from '../lib/format.js'
import { type TaskStatus, taskStatusStyle } from '../lib/status.js'

export interface TaskNodeData extends Record<string, unknown> {
  readonly taskId: string
  readonly title: string
  readonly phase: string
  readonly status: TaskStatus
  readonly attempt: number
  readonly maxAttempts: number
  readonly executor?: string
  readonly durationMs?: number
  readonly onCriticalPath: boolean
  readonly picked: boolean
  /** Motivo de espera projetado do snapshot: task parada nao diz so `PENDING`. */
  readonly waiting?: string
}

export type TaskFlowNode = Node<TaskNodeData, 'task'>

/**
 * Minimo sempre visivel: id, titulo, estado (cor + icone + rotulo) e fase (DASHBOARD 2). O
 * rotulo textual e o `aria-label` garantem que a leitura nao dependa da cor.
 */
export function TaskNodeCard({ data }: { readonly data: TaskNodeData }): JSX.Element {
  const style = taskStatusStyle(data.status)
  const classes = [
    'task-node',
    `task-node--${style.border}`,
    data.onCriticalPath ? 'task-node--critical' : '',
    data.picked ? 'task-node--picked' : '',
    style.pulse ? 'task-node--pulse' : '',
  ]
    .filter((value) => value.length > 0)
    .join(' ')

  const vars = { '--node-color': `var(${style.colorVar})` } as CSSProperties

  return (
    <article
      className={classes}
      style={vars}
      data-testid={`task-node-${data.taskId}`}
      data-status={data.status}
      data-waiting={data.waiting}
      aria-label={`${data.taskId} ${data.title} — estado ${style.label}, fase ${data.phase}${
        data.waiting === undefined ? '' : `, ${data.waiting}`
      }`}
    >
      <div className="task-node__top">
        <span className="task-node__id">{data.taskId}</span>
        <span className="task-node__state">
          <span className="task-node__icon" aria-hidden="true">
            {style.icon}
          </span>
          <span className="task-node__label">{style.label}</span>
        </span>
        {data.maxAttempts > 0 ? (
          <span className="task-node__attempt">{`${data.attempt}/${data.maxAttempts}`}</span>
        ) : null}
      </div>
      <div className="task-node__title">{truncate(data.title, 34)}</div>
      {data.waiting === undefined ? (
        <div className="task-node__foot">
          <span className="task-node__executor">{data.executor ?? data.phase}</span>
          <span className="task-node__duration">{formatDuration(data.durationMs)}</span>
        </div>
      ) : (
        <div className="task-node__foot task-node__foot--waiting">
          <span
            className="task-node__waiting"
            title={data.waiting}
            data-testid={`task-waiting-${data.taskId}`}
          >
            {truncate(data.waiting, 30)}
          </span>
        </div>
      )}
    </article>
  )
}

export function TaskNode({ data }: NodeProps<TaskFlowNode>): JSX.Element {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <TaskNodeCard data={data} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  )
}
