import type { RunSnapshot } from '@agentic/schemas'
import type { JSX } from 'react'
import { elapsedSince, formatClock, formatDuration, formatRatio } from '../lib/format.js'
import { runStatusIcon, TASK_STATUSES, taskStatusStyle } from '../lib/status.js'
import { ProvidersPanel } from './ProvidersPanel.js'

export interface RunHeaderProps {
  readonly snapshot: RunSnapshot
  readonly now: number
  readonly busy?: boolean
  readonly onPause: () => void
  readonly onResume: () => void
}

/**
 * Cabecalho: missao, saude do run, contadores, wall time, metricas e o painel de providers
 * (DASHBOARD 1). `pause`/`resume` sao as unicas acoes de run aqui — a lista de acoes do MVP e
 * fechada (DASHBOARD 7).
 */
export function RunHeader({
  snapshot,
  now,
  busy = false,
  onPause,
  onResume,
}: RunHeaderProps): JSX.Element {
  const { run, counters, metrics } = snapshot
  const paused = run.status === 'PAUSED'
  const live = run.status === 'RUNNING'
  const wallTime = live
    ? (elapsedSince(run.timestamps.startedAt, now) ?? metrics.wallTimeMs)
    : metrics.wallTimeMs
  const shown = TASK_STATUSES.filter((status) => counters[status] > 0)

  return (
    <header className="run-header">
      <div className="run-header__row run-header__row--title">
        <h1 className="run-header__mission">{run.missionId}</h1>
        <span className="run-header__status" data-status={run.status}>
          <span aria-hidden="true">{runStatusIcon(run.status)}</span>
          <span>{run.status}</span>
        </span>
        <span className="run-header__clock">{formatClock(new Date(now).toISOString())}</span>
      </div>

      <div className="run-header__row run-header__counters">
        <strong>{`${snapshot.tasks.length} tasks`}</strong>
        {shown.map((status) => {
          const style = taskStatusStyle(status)
          return (
            <span
              key={status}
              className="counter"
              style={{ color: `var(${style.colorVar})` }}
              data-testid={`counter-${status}`}
            >
              <span aria-hidden="true">{style.icon}</span>
              <span>{`${counters[status]} ${style.label}`}</span>
            </span>
          )
        })}
      </div>

      <div className="run-header__row run-header__metrics">
        <span>{`wall time ${formatDuration(wallTime)}`}</span>
        <span>{`tentativas ${metrics.attempts}`}</span>
        <span>{`retries ${metrics.retries}`}</span>
        <span>{`falhas de review ${metrics.reviewFailures}`}</span>
        <span>{`paralelismo ${formatRatio(metrics.parallelismRatio)}`}</span>
        <span className="run-header__actions">
          {paused ? (
            <button type="button" className="btn" onClick={onResume} disabled={busy}>
              ▶ resume
            </button>
          ) : (
            <button type="button" className="btn" onClick={onPause} disabled={busy || !live}>
              ⏸ pause
            </button>
          )}
        </span>
      </div>

      <ProvidersPanel providers={snapshot.providers} compact />
    </header>
  )
}
