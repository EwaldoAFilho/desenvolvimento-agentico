import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CompiledGraph } from '@agentic/compiler'
import type { MissionSpec, Run, RunStatus } from '@agentic/domain'
import { runId as toRunId } from '@agentic/domain'
import { toCompileReport, UNKNOWN_MISSION } from '@agentic/orchestrator'
import type { CompileReportDto, MissionSummaryDto, RunSummaryDto } from '@agentic/schemas'
import { missionStateOf, parseMissionFile, toMissionSpec } from '@agentic/schemas'
import type { ServerDeps } from './deps.js'
import { toRunSummary, toTaskCounters } from './dto.js'
import { badRequest, HttpError, notFound } from './errors.js'

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
 * Caminho de SAIDA e sempre relativo a raiz do projeto: onde o repositorio mora no disco —
 * e o nome do usuario que aparece nesse caminho — nao atravessa para o navegador
 * (ARCHITECTURE 9).
 */
export function repoRelativePath(deps: ServerDeps, path: string): string {
  return relative(deps.repoRoot, path).split(sep).join('/')
}

function errnoOf(error: unknown): string | undefined {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : undefined
}

/** Arquivo ou diretorio que nao existe. Ausencia e um caso; ilegivel e outro. */
function isMissing(error: unknown): boolean {
  return errnoOf(error) === 'ENOENT'
}

/**
 * Motivo da falha de leitura sem a mensagem do sistema: a do Node embute o caminho ABSOLUTO
 * do host, que e exatamente o que nao pode atravessar. O codigo errno diz o que consertar.
 */
function readFailureOf(deps: ServerDeps, path: string, error: unknown): string {
  return `nao foi possivel ler ${repoRelativePath(deps, path)} (${errnoOf(error) ?? 'erro desconhecido'})`
}

const MISSION_FILE_SUFFIXES = ['.yaml', '.yml']

/**
 * Missoes do repositorio, em ordem estavel. Diretorio ausente e projeto SEM missao, nao
 * falha — e o estado normal de quem acabou de comecar. Qualquer outra falha de leitura vira
 * erro com codigo: engolir tudo numa lista vazia fazia um diretorio ilegivel se passar por
 * projeto novo, e o operador nao tinha o que consertar.
 */
export async function listMissionFiles(deps: ServerDeps): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(deps.missionsDir)
  } catch (error) {
    if (isMissing(error)) return []
    throw new HttpError(
      500,
      'MISSIONS_DIR_UNREADABLE',
      readFailureOf(deps, deps.missionsDir, error),
    )
  }
  return entries
    .filter((name) => MISSION_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix)))
    .sort()
    .map((name) => join(deps.missionsDir, name))
}

/**
 * Le e compila cada missao do diretorio. Arquivo que sumiu ENTRE listar e ler e ignorado —
 * corrida legitima com quem edita o repositorio. Qualquer outra falha de leitura vira erro
 * com codigo: item omitido em silencio seria a Home afirmando que a missao nao existe.
 */
export async function compileMissionCatalog(deps: ServerDeps): Promise<CompiledMission[]> {
  const catalog: CompiledMission[] = []
  for (const path of await listMissionFiles(deps)) {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) continue
      throw new HttpError(500, 'MISSION_FILE_UNREADABLE', readFailureOf(deps, path, error))
    }
    catalog.push(compileMissionSource(deps, { path, text }))
  }
  return catalog
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

/**
 * Runs do projeto, do mais recente para o mais antigo, com os contadores apurados no banco.
 * Leitura pura: nenhum estado e derivado aqui.
 */
export async function listRunSummaries(deps: ServerDeps): Promise<RunSummaryDto[]> {
  const summaries: RunSummaryDto[] = []
  for (const row of deps.plane.persistence.queries.listRuns({})) {
    const id = toRunId(row.id)
    const run = await deps.plane.persistence.runs.loadRun(id)
    if (run === undefined) continue
    const tasks = await deps.plane.persistence.runs.loadTaskRuns(id)
    summaries.push(toRunSummary(run, toTaskCounters(tasks)))
  }
  return summaries
}

/** O run mais recente de cada missao — a lista ja chega do mais novo para o mais antigo. */
export function lastRunByMission(runs: readonly RunSummaryDto[]): Map<string, RunSummaryDto> {
  const last = new Map<string, RunSummaryDto>()
  for (const run of runs) {
    if (!last.has(run.missionId)) last.set(run.missionId, run)
  }
  return last
}

/**
 * Uma missao como a Home mostra. `state` sai de `missionStateOf`, do contrato, e nao de uma
 * regra local: terminal e dashboard precisam pintar a MESMA situacao do mesmo jeito.
 *
 * Missao que nao compila continua na lista — some-la esconderia justamente o que precisa de
 * conserto — mas vai sem titulo: preferimos vazio a um titulo que o arquivo quebrado nao
 * chegou a declarar de forma confiavel.
 */
export function toMissionSummary(
  deps: ServerDeps,
  compiled: CompiledMission,
  lastRun?: RunSummaryDto,
): MissionSummaryDto {
  const report = compiled.report
  const parsed = parseMissionFile(compiled.source.text)
  return {
    ...(report.missionId === UNKNOWN_MISSION ? {} : { id: report.missionId }),
    file: repoRelativePath(deps, compiled.source.path),
    title: report.ok && parsed.ok ? parsed.value.title : '',
    state: missionStateOf({
      compiles: report.ok,
      ...(lastRun === undefined ? {} : { lastRunStatus: lastRun.status }),
    }),
    tasks: report.stats.tasks,
    phases: report.stats.phases,
    errors: report.stats.errors,
    warnings: report.stats.warnings,
    ...(lastRun === undefined ? {} : { lastRun }),
  }
}

/**
 * Catalogo de missoes com o estado que a Home precisa. Os runs vem de fora para que a Home
 * apure a lista UMA vez: a mesma leitura serve a coluna de execucoes e ao ultimo run de
 * cada missao.
 */
export async function missionSummaries(
  deps: ServerDeps,
  runs: readonly RunSummaryDto[],
): Promise<MissionSummaryDto[]> {
  const last = lastRunByMission(runs)
  const catalog = await compileMissionCatalog(deps)
  return catalog.map((compiled) =>
    toMissionSummary(deps, compiled, last.get(compiled.report.missionId)),
  )
}
