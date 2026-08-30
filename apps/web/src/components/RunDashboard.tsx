import type { TaskDetail } from '@agentic/schemas'
import { type JSX, useCallback, useEffect, useState } from 'react'
import { getTaskDetail, pauseRun, resumeRun, retryTask, skipTask, unblockTask } from '../api.js'
import { type RunStreamDeps, useRunStream } from '../hooks/useRunStream.js'
import type { Grouping } from '../lib/dag-layout.js'
import { DagCanvas } from './DagCanvas.js'
import { EventStream } from './EventStream.js'
import { RunHeader } from './RunHeader.js'
import { TaskDetailPanel } from './TaskDetailPanel.js'

/** Relogio de parede do cabecalho. Nao e polling de dados: o estado vem todo do SSE. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export interface RunDashboardProps {
  readonly runId: string
  readonly streamDeps?: RunStreamDeps
  readonly loadTaskDetail?: (runId: string, taskId: string) => Promise<TaskDetail>
}

export function RunDashboard({
  runId,
  streamDeps,
  loadTaskDetail = getTaskDetail,
}: RunDashboardProps): JSX.Element {
  const { state, phase, error } = useRunStream(runId, streamDeps)
  const now = useNow()
  const [grouping, setGrouping] = useState<Grouping>('phase')
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [detail, setDetail] = useState<TaskDetail | undefined>(undefined)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (selected === undefined) {
      setDetail(undefined)
      return
    }
    let cancelled = false
    setLoadingDetail(true)
    loadTaskDetail(runId, selected)
      .then((loaded) => {
        if (!cancelled) setDetail(loaded)
      })
      .catch(() => {
        if (!cancelled) setDetail(undefined)
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false)
      })
    return () => {
      cancelled = true
    }
  }, [runId, selected, loadTaskDetail])

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }, [])

  if (state === undefined) {
    return (
      <main className="loading" aria-label="Carregando run">
        <p>{phase === 'error' ? (error ?? 'falha ao carregar o run') : 'carregando run…'}</p>
      </main>
    )
  }

  return (
    <div className="shell">
      <RunHeader
        snapshot={state.snapshot}
        now={now}
        busy={busy}
        onPause={() => void run(() => pauseRun(runId))}
        onResume={() => void run(() => resumeRun(runId))}
      />
      <div className="shell__body">
        <DagCanvas
          snapshot={state.snapshot}
          grouping={grouping}
          onGroupingChange={setGrouping}
          selectedTaskId={selected}
          onSelectTask={setSelected}
        />
        <TaskDetailPanel
          task={detail}
          loading={loadingDetail}
          busy={busy}
          onClose={() => setSelected(undefined)}
          onRetry={(taskId) => void run(() => retryTask(runId, { taskId }))}
          onUnblock={(taskId, note) => void run(() => unblockTask(runId, { taskId, note }))}
          onSkip={(taskId, reason) => void run(() => skipTask(runId, { taskId, reason }))}
        />
      </div>
      <EventStream events={state.events} onSelectTask={setSelected} />
    </div>
  )
}
