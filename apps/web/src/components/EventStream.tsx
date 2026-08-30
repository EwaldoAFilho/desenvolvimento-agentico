import type { EventDto } from '@agentic/schemas'
import { type JSX, useState } from 'react'
import { formatClock } from '../lib/format.js'

function summarize(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .slice(0, 4)
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' ')
}

export interface EventStreamProps {
  readonly events: readonly EventDto[]
  readonly onSelectTask?: (taskId: string) => void
}

/** Rodape com o stream de eventos, recolhivel (DASHBOARD 1). */
export function EventStream({ events, onSelectTask }: EventStreamProps): JSX.Element {
  const [open, setOpen] = useState(true)
  const recent = [...events].reverse().slice(0, 60)

  return (
    <section className="stream" aria-label="Stream de eventos">
      <button
        type="button"
        className="stream__toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {` eventos (${events.length})`}
      </button>
      {open ? (
        <ol className="stream__list" data-testid="event-stream">
          {recent.map((event) => (
            <li key={event.seq} className="stream__item">
              <span className="stream__ts">{formatClock(event.ts)}</span>
              <span className="stream__type">{event.type}</span>
              {event.taskId === undefined ? (
                <span className="stream__task">—</span>
              ) : (
                <button
                  type="button"
                  className="stream__task stream__task--link"
                  onClick={() => onSelectTask?.(event.taskId ?? '')}
                >
                  {event.taskId}
                </button>
              )}
              <span className="stream__payload">{summarize(event.payload)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}
