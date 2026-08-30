import { toProviderHealthDto } from '@agentic/orchestrator'
import type { ProjectFile, ProviderHealthDto } from '@agentic/schemas'
import { loadProjectContext } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { createOutput, pad, table, tristate } from '../output.js'
import { type CommandResult, failure, ok } from '../result.js'

export const MIN_NODE_MAJOR = 22

export type CheckStatus = 'ok' | 'warn' | 'error' | 'unknown'

export interface DoctorCheck {
  readonly id: string
  readonly title: string
  readonly status: CheckStatus
  readonly detail: string
}

export interface DoctorData {
  readonly ok: boolean
  readonly checks: readonly DoctorCheck[]
  readonly providers: readonly ProviderHealthDto[]
}

function majorOf(version: string): number {
  const first = version.split('.')[0] ?? ''
  const parsed = Number.parseInt(first, 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * `workspace: shared` com `maxParallelTasks > 1` e erro de configuracao: com uma unica
 * arvore de trabalho nao ha paralelismo de escrita possivel (ARCHITECTURE 5.1, DA1010).
 */
export function workspaceCheck(project: ProjectFile): DoctorCheck {
  const execution = project.execution
  if (execution.workspace === 'shared' && execution.maxParallelTasks > 1) {
    return {
      id: 'workspace.shared-parallel',
      title: 'workspace x paralelismo',
      status: 'error',
      detail: `workspace: shared com maxParallelTasks: ${execution.maxParallelTasks} — com uma arvore so, o paralelismo de escrita e 1. Use git-worktree ou reduza para 1.`,
    }
  }
  return {
    id: 'workspace.shared-parallel',
    title: 'workspace x paralelismo',
    status: 'ok',
    detail: `workspace: ${execution.workspace} com maxParallelTasks: ${execution.maxParallelTasks}`,
  }
}

export function capacityCheck(project: ProjectFile): DoctorCheck {
  const total = Object.values(project.providers.registry).reduce(
    (sum, config) => sum + config.maxConcurrent,
    0,
  )
  if (project.execution.maxParallelTasks > total) {
    return {
      id: 'providers.capacity',
      title: 'capacidade somada dos fornecedores',
      status: 'warn',
      detail: `maxParallelTasks ${project.execution.maxParallelTasks} > capacidade somada ${total}: o teto global nunca sera alcancado`,
    }
  }
  return {
    id: 'providers.capacity',
    title: 'capacidade somada dos fornecedores',
    status: 'ok',
    detail: `capacidade somada ${total} · teto global ${project.execution.maxParallelTasks}`,
  }
}

export interface DoctorArgs {
  readonly project?: string
  readonly json?: boolean
}

const MARK: Readonly<Record<CheckStatus, string>> = {
  ok: 'ok',
  warn: 'aviso',
  error: 'ERRO',
  unknown: 'unknown',
}

/** Saude do provider: `ready` desconhecido continua desconhecido, nunca vira aprovacao. */
function providerCheck(health: ProviderHealthDto): DoctorCheck {
  const base = { id: `provider.${health.providerId}`, title: `fornecedor ${health.providerId}` }
  if (health.installed === false) {
    return { ...base, status: 'error', detail: `nao instalado: ${health.detail}` }
  }
  if (health.ready === 'unknown' || health.installed === 'unknown') {
    return {
      ...base,
      status: 'unknown',
      detail: `installed ${tristate(health.installed)} · ready ${tristate(health.ready)} · ${health.detail}`,
    }
  }
  if (health.ready === false) {
    return { ...base, status: 'error', detail: `instalado mas nao pronto: ${health.detail}` }
  }
  return {
    ...base,
    status: 'ok',
    detail: `versao ${health.version} · capacidade ${health.capacity ?? 'sem teto'}`,
  }
}

/**
 * `doctor`: diagnostico do ambiente antes de gastar tempo de agente. Nunca afirma
 * autenticacao a partir de um `--version` que respondeu (R5).
 */
export async function doctorCommand(args: DoctorArgs, deps: CommandDeps): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const context = await loadProjectContext(deps, args)
  const checks: DoctorCheck[] = []

  const major = majorOf(deps.nodeVersion)
  checks.push({
    id: 'node.version',
    title: 'versao do Node',
    status: major >= MIN_NODE_MAJOR ? 'ok' : 'error',
    detail:
      major >= MIN_NODE_MAJOR
        ? `node ${deps.nodeVersion}`
        : `node ${deps.nodeVersion}: o control plane exige >= ${MIN_NODE_MAJOR}`,
  })

  checks.push({
    id: 'project.files',
    title: 'arquivos do projeto',
    status: 'ok',
    detail: `${context.projectPath} e ${context.gatesPath} validos`,
  })

  const gitProbe = await deps.probeGit(context.repoRoot)
  checks.push({
    id: 'git.installed',
    title: 'git disponivel',
    status: gitProbe.installed ? 'ok' : 'error',
    detail: gitProbe.installed ? gitProbe.version : `git nao encontrado: ${gitProbe.detail}`,
  })

  const needsRepo = context.project.execution.workspace === 'git-worktree'
  checks.push({
    id: 'git.repository',
    title: 'repositorio git valido',
    status: gitProbe.repository ? 'ok' : needsRepo ? 'error' : 'warn',
    detail: gitProbe.repository
      ? `${context.repoRoot} e um repositorio git`
      : `${context.repoRoot} nao e repositorio git${needsRepo ? ': workspace git-worktree exige um' : ' — modo shared nao exige'}`,
  })

  checks.push(workspaceCheck(context.project))
  checks.push(capacityCheck(context.project))

  const registry = deps.registry(context.project)
  const health = (await registry.health()).map(toProviderHealthDto)
  for (const provider of health) checks.push(providerCheck(provider))

  out.line(`doctor · ${context.dir}`)
  out.line()
  out.lines(
    checks.map(
      (check) => `  ${pad(MARK[check.status], 8)} ${pad(check.title, 34)} ${check.detail}`,
    ),
  )
  out.line()
  out.lines(
    table(
      ['FORNECEDOR', 'INSTALADO', 'PRONTO', 'VERSAO', 'CAPACIDADE'],
      health.map((provider) => [
        provider.providerId,
        tristate(provider.installed),
        tristate(provider.ready),
        provider.version,
        provider.capacity === null ? 'sem teto' : String(provider.capacity),
      ]),
    ).map((line) => `  ${line}`),
  )
  out.line()
  out.line('`unknown` significa que nao foi possivel apurar — nunca conte como pronto.')

  const errors = checks.filter((check) => check.status === 'error')
  const data: DoctorData = { ok: errors.length === 0, checks, providers: health }
  if (errors.length > 0) {
    return failure(
      'doctor',
      'ENVIRONMENT_INVALID',
      `${errors.length} problema(s): ${errors.map((check) => check.id).join(', ')}`,
      data,
    )
  }
  return ok('doctor', data)
}
