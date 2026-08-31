import type { TaskDetail } from '@agentic/schemas'
import { type JSX, useCallback, useEffect, useMemo, useState } from 'react'
import { getTaskDetail, pauseRun, resumeRun, retryTask, skipTask, unblockTask } from '../api.js'
import { type RunStreamDeps, useRunStream } from '../hooks/useRunStream.js'
import type { Grouping } from '../lib/dag-layout.js'
import { stalledDependents, waitingReasonOf } from '../lib/waiting.js'
import { DagCanvas } from './DagCanvas.js'
import { ErrorScreen } from './ErrorScreen.js'
import { EventStream } from './EventStream.js'
import { RunHeader } from './RunHeader.js'
import { TaskDetailPanel, type TaskPanelContext } from './TaskDetailPanel.js'

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
  /** Saida quando o run nao carrega — sem ela, um id morto na URL e um beco sem saida. */
  readonly onHome?: () => void
}

export function RunDashboard({
  runId,
  streamDeps,
  loadTaskDetail = getTaskDetail,
  onHome,
}: RunDashboardProps): JSX.Element {
  const { state, phase, error, reload } = useRunStream(runId, streamDeps)
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

  /**
   * Contexto do painel: motivo de espera e dependentes parados sao **projecao** do snapshot
   * (nada de estado novo). Ficam aqui porque so o dashboard tem o snapshot inteiro.
   */
  const context = useMemo<TaskPanelContext | undefined>(() => {
    if (state === undefined || selected === undefined) return undefined
    return {
      waiting: waitingReasonOf(state.snapshot, selected),
      stalled: stalledDependents(state.snapshot, selected),
      now,
    }
  }, [state, selected, now])

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }, [])

  if (state === undefined) {
    // Falha no snapshot inicial nao e carregamento: e uma tela sem dado, e ela precisa
    // oferecer a saida em vez de deixar o F5 como unica opcao.
    if (phase === 'error') {
      return (
        <ErrorScreen
          title="Execução não carregou"
          message={error ?? 'falha ao carregar o run'}
          hint={`run ${runId}`}
          onRetry={reload}
          {...(onHome === undefined ? {} : { onHome })}
        />
      )
    }
    return (
      <main className="loading" aria-label="Carregando run">
        <p>carregando run…</p>
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
          context={context}
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
