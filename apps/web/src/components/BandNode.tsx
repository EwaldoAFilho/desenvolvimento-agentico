import type { Node, NodeProps } from '@xyflow/react'
import type { JSX } from 'react'

export interface BandNodeData extends Record<string, unknown> {
  readonly label: string
  readonly width: number
  readonly height: number
}

export type BandFlowNode = Node<BandNodeData, 'band'>

/** Faixa horizontal por fase (ou onda). Serve a leitura, nao a ordem (DASHBOARD 4). */
export function BandNode({ data }: NodeProps<BandFlowNode>): JSX.Element {
  return (
    <div
      className="band"
      style={{ width: data.width, height: data.height }}
      data-testid={`band-${data.label}`}
    >
      <span className="band__label">{data.label}</span>
      <span className="band__rule" />
    </div>
  )
}
