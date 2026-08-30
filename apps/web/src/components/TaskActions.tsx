import type { TaskDetail } from '@agentic/schemas'
import { type JSX, useState } from 'react'

export interface TaskActionsProps {
  readonly task: TaskDetail
  readonly busy?: boolean
  readonly onRetry: (taskId: string) => void
  readonly onUnblock: (taskId: string, note: string) => void
  readonly onSkip: (taskId: string, reason: string) => void
}

/**
 * Tres das seis acoes do MVP (DASHBOARD 7). `unblock` exige nota e `skip` exige motivo — o
 * atrito e deliberado: e o registro de quem decidiu e por que.
 */
export function TaskActions({
  task,
  busy = false,
  onRetry,
  onUnblock,
  onSkip,
}: TaskActionsProps): JSX.Element {
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')

  return (
    <div className="actions">
      <button type="button" className="btn" disabled={busy} onClick={() => onRetry(task.id)}>
        retry
      </button>

      <form
        className="actions__form"
        onSubmit={(event) => {
          event.preventDefault()
          onUnblock(task.id, note.trim())
        }}
      >
        <label className="actions__label" htmlFor="unblock-note">
          nota do unblock (obrigatória)
        </label>
        <input
          id="unblock-note"
          className="actions__input"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="o que destravou"
        />
        <button type="submit" className="btn" disabled={busy || note.trim().length === 0}>
          unblock
        </button>
      </form>

      <form
        className="actions__form"
        onSubmit={(event) => {
          event.preventDefault()
          onSkip(task.id, reason.trim())
        }}
      >
        <label className="actions__label" htmlFor="skip-reason">
          motivo do skip (obrigatório)
        </label>
        <input
          id="skip-reason"
          className="actions__input"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="por que dispensar"
        />
        <button type="submit" className="btn" disabled={busy || reason.trim().length === 0}>
          skip
        </button>
      </form>
    </div>
  )
}
