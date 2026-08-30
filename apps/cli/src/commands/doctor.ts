import { toProviderHealthDto } from '@agentic/orchestrator'
import type { ProjectFile, ProviderHealthDto } from '@agentic/schemas'
import { applyPersistedRunning } from '@agentic/server'
import { loadProjectContext } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { createOutput, pad, table, tristate } from '../output.js'
import { type CommandResult, failure, ok } from '../result.js'
import { readPersistedRunning } from '../running.js'
import {
  capacityLabel,
  type ProviderState,
  type ProviderView,
  providerViewOf,
  renderProviderView,
} from './provider-view.js'

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
  /**
   * Contrato ja publicado: `ProviderHealthDto` cru, com `running` derivado do banco. O DTO
   * exige inteiro, entao quando a apuracao falha o numero do processo permanece ali — e
   * `runningSource` diz que ele nao foi apurado. Quem quer o `unknown` explicito le
   * `providerStates`.
   */
  readonly providers: readonly ProviderHealthDto[]
  /** Os cinco estados, com caminho resolvido, origem da prontidao e diagnostico. */
  readonly providerStates: readonly ProviderView[]
  /** De onde saiu `running`: o estado persistido, ou o motivo de nao ter sido apurado. */
  readonly runningSource: string
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

const CHECK_OF_STATE: Readonly<Record<ProviderState, CheckStatus>> = {
  READY: 'ok',
  INSTALLED: 'ok',
  NOT_READY: 'error',
  NOT_INSTALLED: 'error',
  UNKNOWN: 'unknown',
}

/**
 * Saude do provider como check: o estado decide, e `unknown` continua desconhecido — nunca
 * vira aprovacao (R5). O conserto, quando existe, vai junto: quem le o doctor esta com um
 * problema na mao, nao fazendo auditoria.
 */
export function providerCheck(view: ProviderView): DoctorCheck {
  const parts = [view.state, view.detail]
  const remediation = view.diagnostic?.remediation
  if (remediation !== undefined) parts.push(`conserto: ${remediation}`)
  return {
    id: `provider.${view.provider}`,
    title: `fornecedor ${view.provider}`,
    status: CHECK_OF_STATE[view.state],
    detail: parts.filter((part) => part.length > 0).join(' · '),
  }
}

/**
 * `doctor`: diagnostico do ambiente antes de gastar tempo de agente. Nunca afirma
 * autenticacao a partir de um `--version` que respondeu (R5), e nunca imprime segredo,
 * e-mail ou organizacao (ARCHITECTURE 9).
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

  // Agentes em voo saem do BANCO. O livro-caixa do registry so conhece o proprio processo,
  // e este aqui nao despachou nada — seria zero para tudo, sempre.
  const reading = await readPersistedRunning(deps, context)
  checks.push({
    id: 'state.running',
    title: 'agentes em voo',
    status: reading.derived ? 'ok' : 'unknown',
    detail: reading.derived
      ? `${reading.tally.agents.length} em voo segundo o ${reading.source}`
      : reading.source,
  })

  const registry = deps.registry(context.project)
  const measured = (await registry.health()).map(toProviderHealthDto)
  const health = reading.derived ? applyPersistedRunning(measured, reading.tally) : measured
  const views = health.map((entry) =>
    providerViewOf({
      health: entry,
      executable: context.project.providers.registry[entry.providerId]?.command,
      ...(reading.derived ? { running: entry.running } : {}),
    }),
  )
  for (const view of views) checks.push(providerCheck(view))

  out.line(`doctor · ${context.dir}`)
  out.line()
  out.lines(
    checks.map(
      (check) => `  ${pad(MARK[check.status], 8)} ${pad(check.title, 34)} ${check.detail}`,
    ),
  )
  out.line()
  out.line('fornecedores')
  for (const view of views) {
    out.line()
    out.lines(renderProviderView(view).map((line) => `  ${line}`))
  }
  out.line()
  out.lines(
    table(
      ['FORNECEDOR', 'ESTADO', 'INSTALADO', 'PRONTO', 'VERSAO', 'EM VOO', 'CAPACIDADE'],
      views.map((view) => [
        view.provider,
        view.state,
        tristate(view.installed),
        tristate(view.ready),
        view.version,
        String(view.running),
        capacityLabel(view.capacity),
      ]),
    ).map((line) => `  ${line}`),
  )
  out.line()
  out.line('`unknown` significa que nao foi possivel apurar — nunca conte como pronto.')
  out.line(
    'INSTALLED = instalado com prontidao nao apurada; READY exige sonda de sessao que aprovou.',
  )

  const errors = checks.filter((check) => check.status === 'error')
  const data: DoctorData = {
    ok: errors.length === 0,
    checks,
    providers: health,
    providerStates: views,
    runningSource: reading.source,
  }
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
