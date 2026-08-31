import { resolve } from 'node:path'
import { startServer } from '@agentic/server'
import { type BrowserOutcome, openBrowser } from '../browser.js'
import { loadProjectContext, type ProjectContext } from '../context.js'
import type { BootedServer, CommandDeps } from '../deps.js'
import { describeEndpoint, discoverRuntime, resolveEndpoint } from '../discovery.js'
import type { ControlPlaneLink } from '../link.js'
import { createOutput, type Output, pad } from '../output.js'
import { type CommandResult, failure, messageOf, ok } from '../result.js'
import { type CheckStatus, type DoctorCheck, MIN_NODE_MAJOR } from './doctor.js'
import { SERVER_COMMAND } from './serve.js'

export interface LaunchArgs {
  readonly port?: number
  readonly project?: string
  readonly json?: boolean
  /** `--no-open` desliga a abertura do navegador. Default: abre. */
  readonly open?: boolean
}

export interface LaunchData {
  /** Diretorio que contem o `.agentic/` escolhido — resolvido a partir do cwd. */
  readonly projectDir: string
  readonly endpoint: string
  /** `true` = o control plane ja estava no ar e foi reaproveitado; nada novo foi subido. */
  readonly reused: boolean
  readonly browser: BrowserOutcome
  readonly checks: readonly DoctorCheck[]
}

const MARK: Readonly<Record<CheckStatus, string>> = {
  ok: 'ok',
  warn: 'aviso',
  error: 'ERRO',
  unknown: 'unknown',
}

function majorOf(version: string): number {
  const parsed = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Diagnostico de entrada: o que impede a plataforma de funcionar, apurado antes de abrir a
 * tela. E deliberadamente mais curto que `agentic doctor` — nao sonda fornecedor nem le o
 * banco, porque `agentic` e o comando do dia a dia e nao pode custar uma rodada de sondas.
 */
export async function environmentChecks(
  deps: CommandDeps,
  context: ProjectContext,
): Promise<DoctorCheck[]> {
  const major = majorOf(deps.nodeVersion)
  const probe = await deps.probeGit(context.repoRoot)
  const needsRepo = context.project.execution.workspace === 'git-worktree'
  return [
    {
      id: 'node.version',
      title: 'versao do Node',
      status: major >= MIN_NODE_MAJOR ? 'ok' : 'error',
      detail:
        major >= MIN_NODE_MAJOR
          ? `node ${deps.nodeVersion}`
          : `node ${deps.nodeVersion}: o control plane exige >= ${MIN_NODE_MAJOR}`,
    },
    {
      id: 'project.files',
      title: 'arquivos do projeto',
      status: 'ok',
      detail: `${context.projectPath} e ${context.gatesPath} validos`,
    },
    {
      id: 'git.installed',
      title: 'git disponivel',
      status: probe.installed ? 'ok' : 'error',
      detail: probe.installed ? probe.version : `git nao encontrado: ${probe.detail}`,
    },
    {
      id: 'git.repository',
      title: 'repositorio git valido',
      status: probe.repository ? 'ok' : needsRepo ? 'error' : 'warn',
      detail: probe.repository
        ? `${context.repoRoot} e um repositorio git`
        : `${context.repoRoot} nao e repositorio git${needsRepo ? ': workspace git-worktree exige um' : ' — modo shared nao exige'}`,
    },
  ]
}

function renderChecks(out: Output, checks: readonly DoctorCheck[]): void {
  out.lines(
    checks.map(
      (check) => `  ${pad(MARK[check.status], 8)} ${pad(check.title, 34)} ${check.detail}`,
    ),
  )
  const broken = checks.filter((check) => check.status === 'error')
  if (broken.length === 0) return
  out.line()
  out.line(
    `${broken.length} problema(s) de ambiente: ${broken.map((check) => check.id).join(', ')}`,
  )
  // A Home abre mesmo assim: e nela que o estado do ambiente aparece e e de la que o
  // usuario resolve. Recusar a tela por causa do diagnostico esconderia o diagnostico.
  out.line('a tela abre assim mesmo; `agentic doctor` detalha e diz o conserto')
}

async function openAndReport(
  deps: CommandDeps,
  args: LaunchArgs,
  out: Output,
  url: string,
): Promise<BrowserOutcome> {
  const outcome: BrowserOutcome =
    args.open === false
      ? { opened: false, reason: '--no-open' }
      : await (deps.openBrowser ?? openBrowser)({
          url,
          cwd: deps.cwd,
          platform: deps.platform,
          env: deps.env,
        })
  if (outcome.opened) out.line(`navegador aberto em ${url} (${outcome.command})`)
  else {
    out.line(`navegador nao aberto: ${outcome.reason}`)
    out.line(`abra no navegador: ${url}`)
  }
  return outcome
}

/**
 * Responder na porta nao prova ser o control plane DESTE projeto. `/api/health` publica o
 * `repoRoot` que a instancia serve; sem comparar, `agentic` rodado num projeto adota e opera
 * o control plane de outro que por acaso esteja na mesma porta. E o defeito de abrir o
 * repositorio errado, que ja mordeu este produto antes.
 */
async function identifiedLink(
  deps: CommandDeps,
  endpoint: string,
  context: ProjectContext,
): Promise<ControlPlaneLink | undefined> {
  const link = await deps.connect(endpoint)
  if (link === undefined) return undefined
  try {
    const health = await link.send({ method: 'GET', path: '/api/health' })
    const served = (health.body as { repoRoot?: unknown } | undefined)?.repoRoot
    if (typeof served === 'string' && resolve(served) === resolve(context.repoRoot)) return link
  } catch {
    // Transporte quebrado nao autoriza adotar a instancia: sem prova de identidade, nao e nossa.
    return undefined
  }
  return undefined
}

/**
 * `agentic` sozinho: o projeto e o diretorio de onde o comando foi chamado, o ambiente e
 * diagnosticado, o control plane que ja estiver no ar e reaproveitado — nunca duplicado,
 * porque um segundo escritor no mesmo banco quebra I7 — e o navegador abre na Home.
 *
 * Sem ambiente grafico nada e disparado: a URL e impressa e o processo segue servindo. E o
 * que mantem CI, SSH e maquina sem GUI com a mesma jornada.
 */
export async function launchCommand(args: LaunchArgs, deps: CommandDeps): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const context = await loadProjectContext(deps, args)
  const checks = await environmentChecks(deps, context)

  out.line(`projeto: ${context.project.project.name} · ${context.dir}`)
  out.line()
  renderChecks(out, checks)
  out.line()

  // `--port` diz ONDE preferir; nao autoriza ignorar quem ja esta no ar. Um control plane
  // publicado para ESTE projeto continua sendo reaproveitado mesmo quando a flag pede outra
  // porta: subir um segundo escritor sobre o mesmo banco quebra I7, e uma flag de
  // conveniencia nao vale um invariante. Quando as duas apontam para o mesmo lugar, nada muda.
  const published = await discoverRuntime(context)
  let resolved = await resolveEndpoint(context, args.port === undefined ? {} : { port: args.port })
  if (args.port !== undefined && published !== undefined && published.url !== resolved.endpoint) {
    out.line(`--port ${args.port} ignorado: ja ha control plane deste projeto em ${published.url}`)
    resolved = { endpoint: published.url, source: 'runtime', pid: published.pid }
  }

  const existing = await identifiedLink(deps, resolved.endpoint, context)
  if (existing === undefined && published !== undefined) {
    // Ha runtime publicado para este projeto e nao consegui provar identidade no endereco
    // escolhido. Subir agora seria um segundo escritor sobre o mesmo banco (I7). Entre
    // duplicar o escritor e recusar, o invariante ganha.
    out.line(`control plane publicado em ${published.url} (pid ${published.pid}) nao respondeu`)
    out.line('nao vou subir um segundo: dois escritores no mesmo banco quebram o run.')
    out.line(`se o processo morreu, remova ${context.baseDir}/control-plane.json e tente de novo.`)
    return failure('launch', 'CONTROL_PLANE_UNVERIFIED', 'control plane publicado nao respondeu')
  }
  if (existing !== undefined) {
    out.line(`control plane ja no ar em ${describeEndpoint(resolved)}`)
    const browser = await openAndReport(deps, args, out, resolved.endpoint)
    out.line()
    out.line('nada foi subido: quem serve e o processo que ja estava no ar.')
    return ok('launch', {
      projectDir: context.dir,
      endpoint: resolved.endpoint,
      reused: true,
      browser,
      checks,
    } satisfies LaunchData)
  }

  const boot = deps.bootServer ?? startServer
  let running: BootedServer
  try {
    running = await boot({
      repoRoot: context.repoRoot,
      projectFile: context.projectPath,
      runtimeDir: context.baseDir,
      ...(args.port === undefined ? {} : { port: args.port }),
    })
  } catch (error) {
    const reason = messageOf(error)
    out.line(`nao foi possivel subir o control plane em ${resolved.endpoint}`)
    out.line(reason)
    out.line()
    out.line(`alternativa: ${SERVER_COMMAND}`)
    return failure('launch', 'SERVER_UNAVAILABLE', reason, {
      projectDir: context.dir,
      endpoint: resolved.endpoint,
      reused: false,
      browser: { opened: false, reason: 'o control plane nao subiu' },
      checks,
    } satisfies LaunchData)
  }

  out.line(`control plane no ar em ${running.url}`)
  out.line('endereco publicado em .agentic/control-plane.json enquanto este processo viver')
  const browser = await openAndReport(deps, args, out, running.url)
  out.line()
  out.line('Ctrl+C encerra o control plane.')
  await deps.waitForShutdown()
  await running.close()
  return ok('launch', {
    projectDir: context.dir,
    endpoint: running.url,
    reused: false,
    browser,
    checks,
  } satisfies LaunchData)
}
