import type { Run, RunId, TaskId } from '@agentic/domain'
import { isRunId, isTaskId } from '@agentic/domain'
import type { ControlPlane, OwnershipLease } from '@agentic/orchestrator'
import type { ProjectContext } from './context.js'
import type { CommandDeps } from './deps.js'
import { describeEndpoint, resolveEndpoint } from './discovery.js'
import type { ControlPlaneLink } from './link.js'
import { CliError, usageError } from './result.js'

/**
 * Abre o control plane local a partir do projeto ja validado.
 *
 * `baseDir` e o diretorio de ESTADO (`context.runtimeDir`), nao o de configuracao: e ele que
 * a posse protege, e abrir o banco em outro lugar era abrir um SEGUNDO `state.db` para o
 * mesmo projeto (I14).
 *
 * Com `lease`, o plane pode MUTAR, porque provou ser o dono. Sem `lease`, ele so le: as
 * operacoes de escrita recusam por conta propria, entao um comando de leitura nao precisa
 * disputar posse e um comando de mutacao nao consegue esquecer de disputar.
 */
export function openPlane(
  deps: CommandDeps,
  context: ProjectContext,
  lease?: OwnershipLease,
): ControlPlane {
  return deps.controlPlane({
    project: context.project,
    gatesFile: context.gatesFile,
    repoRoot: context.repoRoot,
    baseDir: context.runtimeDir,
    registry: deps.registry(context.project),
    ...(lease === undefined ? {} : { lease }),
  })
}

/** Abre, usa e fecha: nenhum comando deixa conexao de banco aberta atras de si. */
export async function withPlane<T>(
  deps: CommandDeps,
  context: ProjectContext,
  work: (plane: ControlPlane) => Promise<T>,
  lease?: OwnershipLease,
): Promise<T> {
  const plane = openPlane(deps, context, lease)
  try {
    return await work(plane)
  } finally {
    await plane.close().catch(() => undefined)
  }
}

export function parseRunId(raw: string): RunId {
  if (!isRunId(raw)) throw usageError(`runId invalido: ${raw}`, 'INVALID_RUN_ID')
  return raw
}

export function parseTaskId(raw: string): TaskId {
  if (!isTaskId(raw)) throw usageError(`taskId invalido: ${raw}`, 'INVALID_TASK_ID')
  return raw
}

/** Sem `runId` explicito, o run corrente e o mais recente do banco. */
export async function resolveRunId(plane: ControlPlane, raw?: string): Promise<RunId> {
  if (raw !== undefined) return parseRunId(raw)
  const rows = plane.persistence.queries.listRuns({ limit: 1 })
  const latest = rows[0]
  if (latest === undefined) {
    throw new CliError('NO_RUN', 'nenhum run neste projeto; use `agentic mission start <arquivo>`')
  }
  return parseRunId(latest.id)
}

/** Run mais recente da missao, opcionalmente amarrado ao `specHash` compilado agora. */
export async function findMissionRun(
  plane: ControlPlane,
  missionId: string,
  specHash?: string,
): Promise<Run | undefined> {
  const rows = plane.persistence.queries.listRuns({ limit: 200 })
  for (const row of rows) {
    if (row.mission_id !== missionId) continue
    if (!isRunId(row.id)) continue
    const run = await plane.persistence.runs.loadRun(row.id)
    if (run === undefined) continue
    if (specHash !== undefined && run.specHash !== specHash) continue
    return run
  }
  return undefined
}

/**
 * Primeira coisa que o usuario le, palavra por palavra. O diagnostico longo vem depois:
 * quem so quer voltar a trabalhar precisa dos DOIS comandos, na ordem, sem interpretar nada.
 */
export const NO_CONTROL_PLANE_HEADER = [
  'Nenhum control plane ativo.',
  '  Suba:    agentic serve',
  '  Depois:  agentic mission pause <run>',
].join('\n')

/**
 * A mensagem que o usuario ve quando nao ha control plane no ar.
 *
 * Recusar continua certo (I7: ninguem escreve no banco por fora do orquestrador). O que a
 * mensagem faz e dizer o caminho de volta — o comando exato primeiro, o porque depois.
 */
export function noControlPlaneMessage(endpoint: string, tried?: string): string {
  return [
    NO_CONTROL_PLANE_HEADER,
    '',
    `nenhum control plane respondendo em ${tried ?? endpoint}.`,
    'comando de mutacao nao escreve no banco por fora do orquestrador (I7), entao ele precisa',
    'de um processo publicando HTTP. Duas causas comuns:',
    `  1. nao ha control plane no ar        -> \`agentic serve\``,
    '  2. ha um run em primeiro plano iniciado com `--no-serve` (ou, numa versao anterior,',
    '     SEM `--serve`): esse modo orquestra mas NAO publica HTTP, entao pause, resume, stop,',
    '     retry, unblock e skip ficam inalcancaveis ate ele terminar (Ctrl+C encerra o run).',
    '     `agentic mission start <arquivo>` ja publica a API por padrao;',
    '     `agentic mission start <arquivo> --serve` ainda mantem o control plane no ar depois',
    '     que o run termina.',
  ].join('\n')
}

/**
 * Mutacao sobre run exige o control plane no ar (ARCHITECTURE 4). Sem processo, a CLI diz
 * isso — nao escreve no banco por fora do unico escritor (I7).
 *
 * O endereco tentado sai da descoberta (`.agentic/control-plane.json` com processo vivo),
 * nao de um endereco fixo: o processo que esta no ar agora pode nao estar na porta que o
 * `project.yaml` declara.
 */
export async function requireLink(
  deps: CommandDeps,
  context: ProjectContext,
  port?: number,
): Promise<ControlPlaneLink> {
  const resolved = await resolveEndpoint(context, port === undefined ? {} : { port })
  const link = await deps.connect(resolved.endpoint, { repoRoot: context.repoRoot })
  if (link === undefined) {
    throw new CliError(
      'NO_CONTROL_PLANE',
      noControlPlaneMessage(resolved.endpoint, describeEndpoint(resolved)),
    )
  }
  return link
}
