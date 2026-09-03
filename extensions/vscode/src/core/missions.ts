import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type { CompileReportDto, MissionListItem, RunHeaderDto } from './contracts.js'

/**
 * Missions como a sidebar mostra: id, estado e ultimo run. O arquivo e listado pelo control
 * plane quando ele esta no ar (`GET /api/missions`) e pelo disco quando nao esta — a lista
 * nao some porque o processo parou. Runs so existem pelo control plane (I7): sem ele, o
 * ultimo run e "nao apurado", nunca "nenhum".
 */
export type MissionState =
  | 'UNKNOWN'
  | 'INVALID'
  | 'READY'
  | 'DRAFT'
  | 'APPROVED'
  | 'RUNNING'
  | 'PAUSED'
  | 'BLOCKED'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export interface MissionSummary {
  readonly id: string
  /** Relativo ao `repoRoot`, como o servidor devolve. */
  readonly file: string
  readonly path: string
  readonly state: MissionState
  readonly ok?: boolean
  readonly stats?: CompileReportDto['stats']
  readonly diagnostics?: CompileReportDto['diagnostics']
  readonly lastRun?: RunHeaderDto
  /** `false` quando os runs nao puderam ser consultados (control plane parado). */
  readonly runsKnown: boolean
}

const MISSION_FILE = /\.(mission\.)?ya?ml$/i

export function missionIdOfFile(file: string): string {
  return basename(file).replace(MISSION_FILE, '')
}

/** Lista do disco, para quando o control plane nao esta no ar. Mesmo filtro do servidor. */
export function missionFilesOnDisk(
  missionsDir: string,
  repoRoot: string,
  entries: readonly string[],
): MissionListItem[] {
  return entries
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => {
      const path = join(missionsDir, name)
      const rel = relative(repoRoot, path)
      const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
      return { file: inside ? rel.split(sep).join('/') : path, path }
    })
}

export function stateOfRun(status: string | undefined, ok: boolean | undefined): MissionState {
  switch (status) {
    case 'DRAFT':
    case 'APPROVED':
    case 'RUNNING':
    case 'PAUSED':
    case 'BLOCKED':
    case 'VERIFYING':
    case 'COMPLETED':
    case 'FAILED':
    case 'CANCELLED':
      return status
    default:
      if (ok === undefined) return 'UNKNOWN'
      return ok ? 'READY' : 'INVALID'
  }
}

export function summarizeMissions(
  files: readonly MissionListItem[],
  runs: readonly RunHeaderDto[] | undefined,
  reports: ReadonlyMap<string, CompileReportDto>,
): MissionSummary[] {
  return files.map((item) => {
    const report = reports.get(item.file)
    const id = report?.missionId ?? missionIdOfFile(item.file)
    const lastRun = runs?.find((run) => run.missionId === id)
    return {
      id,
      file: item.file,
      path: item.path,
      state: stateOfRun(lastRun?.status, report?.ok),
      runsKnown: runs !== undefined,
      ...(report === undefined
        ? {}
        : { ok: report.ok, stats: report.stats, diagnostics: report.diagnostics }),
      ...(lastRun === undefined ? {} : { lastRun }),
    }
  })
}
