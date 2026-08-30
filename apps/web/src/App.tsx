import type { CompileReportDto, ProviderHealthDto } from '@agentic/schemas'
import { type JSX, useCallback, useEffect, useState } from 'react'
import { approveMission, getCompileReport, getProviders, listRuns, startRun } from './api.js'
import { RunDashboard } from './components/RunDashboard.js'
import { StartMission } from './components/StartMission.js'

function queryParam(name: string): string | undefined {
  if (typeof window === 'undefined') return undefined
  const value = new URLSearchParams(window.location.search).get(name)
  return value === null || value.length === 0 ? undefined : value
}

/**
 * Duas telas, uma sequencia: antes do run existe a missao compilada com o botao de partida;
 * depois, o DAG vivo (DASHBOARD 1 e 2.1).
 */
export function App(): JSX.Element {
  const [runId, setRunId] = useState<string | undefined>(() => queryParam('run'))
  const missionId = queryParam('mission')
  const [report, setReport] = useState<CompileReportDto | undefined>(undefined)
  const [providers, setProviders] = useState<readonly ProviderHealthDto[]>([])
  const [approved, setApproved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (runId !== undefined) return
    let cancelled = false
    const boot = async (): Promise<void> => {
      const runs = await listRuns().catch(() => [])
      const active = runs.find((candidate) => candidate.status === 'RUNNING') ?? runs[0]
      if (!cancelled && active !== undefined && missionId === undefined) {
        setRunId(active.id)
        return
      }
      const mission = missionId ?? active?.missionId
      if (mission === undefined) return
      const [compiled, health] = await Promise.all([
        getCompileReport(mission).catch(() => undefined),
        getProviders().catch(() => [] as ProviderHealthDto[]),
      ])
      if (cancelled) return
      if (compiled !== undefined) setReport(compiled)
      setProviders(health)
      setApproved(active?.status === 'APPROVED')
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [runId, missionId])

  const onApprove = useCallback(
    (actor: string, note: string) => {
      if (report === undefined) return
      setBusy(true)
      approveMission(report.missionId, note.length > 0 ? { actor, note } : { actor })
        .then(() => setApproved(true))
        .catch((cause: unknown) => setError(String(cause)))
        .finally(() => setBusy(false))
    },
    [report],
  )

  const onStart = useCallback(
    (acceptWarnings: boolean, actor: string) => {
      if (report === undefined) return
      setBusy(true)
      startRun({ missionId: report.missionId, acceptWarnings, actor })
        .then((created) => setRunId(created))
        .catch((cause: unknown) => setError(String(cause)))
        .finally(() => setBusy(false))
    },
    [report],
  )

  if (runId !== undefined) return <RunDashboard runId={runId} />

  if (report === undefined) {
    return (
      <main className="loading" aria-label="Carregando missão">
        <p>carregando missão compilada…</p>
      </main>
    )
  }

  return (
    <StartMission
      report={report}
      approved={approved}
      providers={providers}
      busy={busy}
      error={error}
      onApprove={onApprove}
      onStart={onStart}
    />
  )
}
