import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { CompiledGraph } from '@agentic/compiler'
import type { MissionSpec, Run, RunStatus } from '@agentic/domain'
import { runId as toRunId } from '@agentic/domain'
import { toCompileReport } from '@agentic/orchestrator'
import type { CompileReportDto } from '@agentic/schemas'
import { parseMissionFile, toMissionSpec } from '@agentic/schemas'
import type { ServerDeps } from './deps.js'
import { badRequest, notFound } from './errors.js'

export interface MissionSource {
  readonly path: string
  readonly text: string
}

export interface CompiledMission {
  readonly source: MissionSource
  readonly report: CompileReportDto
  readonly graph: CompiledGraph | undefined
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`)
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve a referencia de missao vinda do usuario: caminho relativo ao repositorio ou id
 * curto procurado em `.agentic/missions`. Sempre confinado ao repositorio — referencia que
 * escapa da raiz e recusada, nao lida.
 */
export async function resolveMissionPath(deps: ServerDeps, ref: string): Promise<string> {
  const trimmed = ref.trim()
  if (trimmed.length === 0) throw badRequest('MISSION_REF_INVALID', 'informe a missao')
  const looksLikePath = isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')
  const candidates = looksLikePath
    ? [resolve(deps.repoRoot, trimmed)]
    : [
        join(deps.missionsDir, `${trimmed}.mission.yaml`),
        join(deps.missionsDir, `${trimmed}.yaml`),
        join(deps.missionsDir, trimmed),
        resolve(deps.repoRoot, trimmed),
      ]
  for (const candidate of candidates) {
    if (!inside(deps.repoRoot, candidate)) {
      throw badRequest('MISSION_REF_INVALID', `${ref} aponta fora do repositorio`)
    }
    if (await isFile(candidate)) return candidate
  }
  throw notFound('MISSION_NOT_FOUND', `missao ${ref} nao encontrada`)
}

export async function readMissionSource(deps: ServerDeps, ref: string): Promise<MissionSource> {
  const path = await resolveMissionPath(deps, ref)
  return { path, text: await readFile(path, 'utf8') }
}

/**
 * CompileMission no caso de uso do orquestrador. O servidor nao valida DAG, nao calcula
 * caminho critico e nao escolhe severidade: so entrega texto e devolve o relatorio.
 */
export function compileMissionSource(deps: ServerDeps, source: MissionSource): CompiledMission {
  const result = deps.plane.compileMission({
    missionText: source.text,
    projectFile: deps.projectText,
    gatesFile: deps.gatesText,
  })
  return { source, report: toCompileReport(result, source.text), graph: result.graph }
}

export async function compileMissionRef(deps: ServerDeps, ref: string): Promise<CompiledMission> {
  return compileMissionSource(deps, await readMissionSource(deps, ref))
}

export function missionSpecOf(source: MissionSource): MissionSpec {
  const parsed = parseMissionFile(source.text)
  if (!parsed.ok) {
    throw badRequest('MISSION_FILE_INVALID', `${source.path} invalido`, {
      issues: parsed.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    })
  }
  return toMissionSpec(parsed.value)
}

/** Recusa com a LISTA: com ERROR nao ha botao de partida, ha erros para corrigir. */
export function refuseOnErrors(compiled: CompiledMission): void {
  if (compiled.report.ok) return
  throw badRequest(
    'MISSION_HAS_ERRORS',
    `missao ${compiled.report.missionId} tem diagnostico ERROR: corrija o YAML`,
    { diagnostics: compiled.report.diagnostics.filter((item) => item.severity === 'ERROR') },
  )
}

export function warningsOf(report: CompileReportDto): CompileReportDto['diagnostics'] {
  return report.diagnostics.filter((item) => item.severity === 'WARNING')
}

export interface RunLookup {
  readonly missionId: string
  /** Aprovacao vale para UM spec: editar o YAML depois invalida o aceite (ADR-0005). */
  readonly specHash?: string
  readonly statuses?: readonly RunStatus[]
}

/**
 * Procura o run correspondente a uma missao. Leitura direta das consultas do dashboard —
 * nada aqui escreve.
 */
export async function findRuns(deps: ServerDeps, lookup: RunLookup): Promise<Run[]> {
  const rows = deps.plane.persistence.queries.listRuns(
    lookup.statuses === undefined ? {} : { status: [...lookup.statuses] },
  )
  const found: Run[] = []
  for (const row of rows) {
    if (row.mission_id !== lookup.missionId) continue
    const run = await deps.plane.persistence.runs.loadRun(toRunId(row.id))
    if (run === undefined) continue
    if (lookup.specHash !== undefined && run.specHash !== lookup.specHash) continue
    found.push(run)
  }
  return found
}

export async function findRun(deps: ServerDeps, lookup: RunLookup): Promise<Run | undefined> {
  return (await findRuns(deps, lookup))[0]
}
