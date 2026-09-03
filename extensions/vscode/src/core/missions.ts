import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type {
  CompileReportDto,
  MissionSummaryDto,
  MissionViewState,
  RunSummaryDto,
} from './contracts.js'

/**
 * Missions como a sidebar mostra: id, estado e ultimo run. Com o control plane no ar a
 * listagem ja vem enriquecida (`GET /api/missions`: estado, contadores, ultimo run); parada,
 * a lista vem do disco (mesmo filtro do servidor) e tudo que depende de run e "nao apurado",
 * nunca "nenhum" (I7: run so existe pelo control plane).
 */
export type MissionState = MissionViewState | 'UNKNOWN'

export interface MissionSummary {
  readonly id: string
  /** Relativo ao `repoRoot`, como o servidor devolve. */
  readonly file: string
  readonly path: string
  readonly title: string
  readonly state: MissionState
  readonly tasks?: number
  readonly phases?: number
  readonly errors?: number
  readonly warnings?: number
  readonly lastRun?: RunSummaryDto
  /** `false` quando o control plane nao pode ser consultado (parado). */
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
): MissionSummary[] {
  return entries
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => {
      const path = join(missionsDir, name)
      const rel = relative(repoRoot, path)
      const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
      const file = inside ? rel.split(sep).join('/') : path
      return {
        id: missionIdOfFile(name),
        file,
        path,
        title: '',
        state: 'UNKNOWN',
        runsKnown: false,
      }
    })
}

/** Listagem do control plane, com o caminho absoluto resolvido para o editor abrir. */
export function summariesFromControlPlane(
  repoRoot: string,
  items: readonly MissionSummaryDto[],
): MissionSummary[] {
  return items.map((item) => ({
    id: item.id ?? missionIdOfFile(item.file),
    file: item.file,
    path: join(repoRoot, item.file),
    title: item.title,
    state: item.state,
    tasks: item.tasks,
    phases: item.phases,
    errors: item.errors,
    warnings: item.warnings,
    runsKnown: true,
    ...(item.lastRun === undefined ? {} : { lastRun: item.lastRun }),
  }))
}

/** Relatorio de compile de uma mission, quando o host o pediu (detalhe). */
export function withReport(
  summary: MissionSummary,
  report: CompileReportDto | undefined,
): MissionSummary {
  if (report === undefined) return summary
  return {
    ...summary,
    tasks: report.stats.tasks,
    phases: report.stats.phases,
    errors: report.stats.errors,
    warnings: report.stats.warnings,
  }
}
