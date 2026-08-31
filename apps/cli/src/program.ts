import { Command, CommanderError, type OptionValues } from 'commander'
import { doctorCommand } from './commands/doctor.js'
import { eventsTailCommand } from './commands/events-tail.js'
import { initCommand } from './commands/init.js'
import { missionApproveCommand } from './commands/mission-approve.js'
import { missionCompileCommand } from './commands/mission-compile.js'
import { missionStartCommand } from './commands/mission-start.js'
import { missionStatusCommand } from './commands/mission-status.js'
import { missionValidateCommand } from './commands/mission-validate.js'
import {
  pauseCommand,
  resumeCommand,
  stopCommand,
  taskRetryCommand,
  taskSkipCommand,
  taskUnblockCommand,
} from './commands/mutations.js'
import { providersCommand } from './commands/providers.js'
import { runReportCommand } from './commands/run-report.js'
import { serveCommand } from './commands/serve.js'
import { taskInspectCommand } from './commands/task-inspect.js'
import { type CommandDeps, defaultDeps } from './deps.js'
import { emit } from './output.js'
import {
  CliError,
  type CommandResult,
  codeOf,
  EXIT_OK,
  EXIT_USAGE,
  failure,
  messageOf,
  ok,
  usage,
} from './result.js'

export const VERSION = '0.1.0'

interface ProgramState {
  result: CommandResult
}

/** Executa um handler e converte qualquer erro em `CommandResult` — nunca em stack solta. */
export async function execute(
  deps: CommandDeps,
  command: string,
  json: boolean,
  work: () => Promise<CommandResult>,
): Promise<CommandResult> {
  let result: CommandResult
  try {
    result = await work()
  } catch (error) {
    result =
      error instanceof CliError && error.usage
        ? usage(command, error.message, error.code)
        : failure(command, codeOf(error), messageOf(error))
  }
  emit(deps, result, json)
  return result
}

function intOf(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed))
    throw new CliError('INVALID_OPTION', `${name} espera um numero: ${raw}`, { usage: true })
  return parsed
}

function common(command: Command): Command {
  return command
    .option('--json', 'saida em JSON estavel')
    .option('-C, --project <dir>', 'diretorio do projeto (default: procura .agentic acima do cwd)')
}

function withPort(command: Command): Command {
  return command.option('--port <n>', 'porta do control plane (default: server.port do projeto)')
}

interface CommonOptions {
  readonly json?: boolean
  readonly project?: string
  readonly port?: string
  readonly actor?: string
  readonly reason?: string
  readonly note?: string
  readonly run?: string
  readonly since?: string
  readonly limit?: string
  readonly follow?: boolean
  readonly md?: boolean
  readonly acceptWarnings?: boolean
  readonly serve?: boolean
}

function base(options: OptionValues): CommonOptions {
  return options as CommonOptions
}

/**
 * Wiring do `commander`. Nao ha regra de negocio aqui: o programa traduz argv em `args` e
 * delega ao handler, que e uma funcao pura de entrada -> `CommandResult`.
 */
export function buildProgram(deps: CommandDeps, state: ProgramState): Command {
  const program = new Command()
  program
    .name('agentic')
    .description('Control plane para engenharia de software agentica')
    .version(VERSION, '-v, --version', 'mostra a versao')
    .showHelpAfterError('(use --help para ver as opcoes)')
    .configureOutput({
      writeOut: (text) => deps.stdout(text),
      writeErr: (text) => deps.stderr(text),
    })

  const run = async (
    command: string,
    options: CommonOptions,
    work: () => Promise<CommandResult>,
  ): Promise<void> => {
    state.result = await execute(deps, command, options.json === true, work)
  }

  common(program.command('init'))
    .description('cria .agentic/ com project.yaml, gates.yaml e uma missao de exemplo')
    .argument('[dir]', 'diretorio do projeto', '.')
    .action(async (dir: string, options: OptionValues) => {
      const opts = base(options)
      await run('init', opts, () => initCommand({ dir, json: opts.json === true }, deps))
    })

  const mission = program.command('mission').description('ciclo de vida de uma missao')

  common(mission.command('validate'))
    .description('valida schema e semantica; sai 1 com qualquer ERROR')
    .argument('<arquivo>', 'caminho do mission.yaml')
    .action(async (file: string, options: OptionValues) => {
      const opts = base(options)
      await run('mission validate', opts, () =>
        missionValidateCommand({ file, ...pick(opts) }, deps),
      )
    })

  common(mission.command('compile'))
    .description('imprime o DAG: fases, waves, caminho critico, concorrencia e conflitos')
    .argument('<arquivo>', 'caminho do mission.yaml')
    .action(async (file: string, options: OptionValues) => {
      const opts = base(options)
      await run('mission compile', opts, () => missionCompileCommand({ file, ...pick(opts) }, deps))
    })

  withPort(common(mission.command('approve')))
    .description('registra a aprovacao humana da missao')
    .argument('<arquivo>', 'caminho do mission.yaml')
    .option('--actor <nome>', 'quem aprova (obrigatorio)')
    .option('--note <texto>', 'observacao registrada com a aprovacao')
    .action(async (file: string, options: OptionValues) => {
      const opts = base(options)
      await run('mission approve', opts, () =>
        missionApproveCommand(
          {
            file,
            ...pick(opts),
            ...(opts.actor === undefined ? {} : { actor: opts.actor }),
            ...(opts.note === undefined ? {} : { note: opts.note }),
            ...portOf(opts),
          },
          deps,
        ),
      )
    })

  withPort(common(mission.command('start')))
    .description('cria o run, orquestra e publica a API HTTP; exige missao APPROVED')
    .argument('<arquivo>', 'caminho do mission.yaml')
    .option('--accept-warnings', 'aceita explicitamente os WARNING pendentes')
    .option(
      '--serve',
      'mantem o control plane no ar depois que o run termina (Ctrl+C encerra); a API ja e publicada por padrao',
    )
    .option(
      '--no-serve',
      'NAO publica a API HTTP: pause, resume, stop, retry, unblock e skip nao alcancam o run',
    )
    .option('--actor <nome>', 'quem inicia (default: usuario do ambiente)')
    .action(async (file: string, options: OptionValues) => {
      const opts = base(options)
      await run('mission start', opts, () =>
        missionStartCommand(
          {
            file,
            ...pick(opts),
            acceptWarnings: opts.acceptWarnings === true,
            // Tres estados: ausente = publica e encerra no fim; --serve = fica no ar depois
            // do fim; --no-serve = nao publica HTTP.
            ...(opts.serve === undefined ? {} : { serve: opts.serve }),
            ...(opts.actor === undefined ? {} : { actor: opts.actor }),
            ...portOf(opts),
          },
          deps,
        ),
      )
    })

  common(mission.command('status'))
    .description('retrato do run: estado, tasks, providers e metricas')
    .argument('[runId]', 'run alvo (default: o mais recente)')
    .action(async (runId: string | undefined, options: OptionValues) => {
      const opts = base(options)
      await run('mission status', opts, () =>
        missionStatusCommand({ ...pick(opts), ...(runId === undefined ? {} : { runId }) }, deps),
      )
    })

  for (const [name, handler, description] of [
    ['pause', pauseCommand, 'pausa o run: nada novo e despachado'],
    ['resume', resumeCommand, 'volta a despachar'],
    ['stop', stopCommand, 'cancela o run e encerra as tentativas em voo'],
  ] as const) {
    withPort(common(mission.command(name)))
      .description(description)
      .argument('[runId]', 'run alvo (default: o mais recente)')
      .option('--actor <nome>', 'quem comanda')
      .option('--reason <texto>', 'motivo registrado')
      .action(async (runId: string | undefined, options: OptionValues) => {
        const opts = base(options)
        await run(`mission ${name}`, opts, () =>
          handler(
            {
              ...pick(opts),
              ...(runId === undefined ? {} : { runId }),
              ...(opts.actor === undefined ? {} : { actor: opts.actor }),
              ...(opts.reason === undefined ? {} : { reason: opts.reason }),
              ...portOf(opts),
            },
            deps,
          ),
        )
      })
  }

  withPort(common(program.command('serve')))
    .description('sobe o control plane sem run ativo')
    .action(async (options: OptionValues) => {
      const opts = base(options)
      await run('serve', opts, () => serveCommand({ ...pick(opts), ...portOf(opts) }, deps))
    })

  const task = program.command('task').description('operacao sobre uma task do run')

  common(task.command('inspect'))
    .description('detalhe completo da task, com worktree e branch')
    .argument('<taskId>', 'id da task (ex.: T05)')
    .option('--run <id>', 'run alvo (default: o mais recente)')
    .action(async (taskId: string, options: OptionValues) => {
      const opts = base(options)
      await run('task inspect', opts, () =>
        taskInspectCommand(
          { taskId, ...pick(opts), ...(opts.run === undefined ? {} : { runId: opts.run }) },
          deps,
        ),
      )
    })

  withPort(common(task.command('retry')))
    .description('reabre a task com uma tentativa autorizada')
    .argument('<taskId>', 'id da task')
    .option('--run <id>', 'run alvo')
    .option('--actor <nome>', 'quem comanda')
    .option('--reason <texto>', 'motivo registrado')
    .action(async (taskId: string, options: OptionValues) => {
      const opts = base(options)
      await run('task retry', opts, () => taskRetryCommand({ taskId, ...taskArgs(opts) }, deps))
    })

  withPort(common(task.command('unblock')))
    .description('desbloqueia a task; EXIGE --note')
    .argument('<taskId>', 'id da task')
    .option('--run <id>', 'run alvo')
    .option('--actor <nome>', 'quem comanda')
    .option('--note <texto>', 'justificativa (obrigatoria)')
    .action(async (taskId: string, options: OptionValues) => {
      const opts = base(options)
      await run('task unblock', opts, () => taskUnblockCommand({ taskId, ...taskArgs(opts) }, deps))
    })

  withPort(common(task.command('skip')))
    .description('pula a task; EXIGE --reason')
    .argument('<taskId>', 'id da task')
    .option('--run <id>', 'run alvo')
    .option('--actor <nome>', 'quem comanda')
    .option('--reason <texto>', 'motivo (obrigatorio)')
    .action(async (taskId: string, options: OptionValues) => {
      const opts = base(options)
      await run('task skip', opts, () => taskSkipCommand({ taskId, ...taskArgs(opts) }, deps))
    })

  const runGroup = program.command('run').description('consultas sobre um run')

  common(runGroup.command('report'))
    .description('relatorio final da missao')
    .argument('[runId]', 'run alvo (default: o mais recente)')
    .option('--md', 'saida em markdown')
    .action(async (runId: string | undefined, options: OptionValues) => {
      const opts = base(options)
      await run('run report', opts, () =>
        runReportCommand(
          { ...pick(opts), ...(runId === undefined ? {} : { runId }), md: opts.md === true },
          deps,
        ),
      )
    })

  const events = program.command('events').description('log append-only do run')

  common(events.command('tail'))
    .description('lista eventos a partir de um seq')
    .argument('[runId]', 'run alvo (default: o mais recente)')
    .option('--since <seq>', 'ultimo seq ja visto (exclusivo)')
    .option('--limit <n>', 'maximo de eventos')
    .option('--follow', 'segue o log ate Ctrl+C')
    .action(async (runId: string | undefined, options: OptionValues) => {
      const opts = base(options)
      await run('events tail', opts, () => {
        const since = intOf(opts.since, '--since')
        const limit = intOf(opts.limit, '--limit')
        return eventsTailCommand(
          {
            ...pick(opts),
            ...(runId === undefined ? {} : { runId }),
            ...(since === undefined ? {} : { since }),
            ...(limit === undefined ? {} : { limit }),
            follow: opts.follow === true,
          },
          deps,
        )
      })
    })

  common(program.command('providers'))
    .description('instalado / pronto / versao / em uso / capacidade por fornecedor')
    .action(async (options: OptionValues) => {
      const opts = base(options)
      await run('providers', opts, () => providersCommand(pick(opts), deps))
    })

  common(program.command('doctor'))
    .description('diagnostico do ambiente: node, git, workspace e fornecedores')
    .action(async (options: OptionValues) => {
      const opts = base(options)
      await run('doctor', opts, () => doctorCommand(pick(opts), deps))
    })

  applyExitOverride(program)
  return program
}

function pick(options: CommonOptions): { json?: boolean; project?: string } {
  return {
    ...(options.json === undefined ? {} : { json: options.json }),
    ...(options.project === undefined ? {} : { project: options.project }),
  }
}

function portOf(options: CommonOptions): { port?: number } {
  const port = intOf(options.port, '--port')
  return port === undefined ? {} : { port }
}

function taskArgs(options: CommonOptions): {
  json?: boolean
  project?: string
  runId?: string
  actor?: string
  reason?: string
  note?: string
  port?: number
} {
  return {
    ...pick(options),
    ...(options.run === undefined ? {} : { runId: options.run }),
    ...(options.actor === undefined ? {} : { actor: options.actor }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.note === undefined ? {} : { note: options.note }),
    ...portOf(options),
  }
}

function applyExitOverride(command: Command): void {
  command.exitOverride()
  for (const child of command.commands) applyExitOverride(child)
}

const HELP_CODES = new Set(['commander.help', 'commander.helpDisplayed', 'commander.version'])

/**
 * Ponto de entrada do binario. Devolve o codigo de saida em vez de encerrar o processo:
 * 0 ok · 1 erro de validacao ou execucao · 2 erro de uso.
 */
export async function main(
  argv: readonly string[],
  overrides: Partial<CommandDeps> = {},
): Promise<number> {
  const deps: CommandDeps = { ...defaultDeps(), ...overrides }
  const state: ProgramState = { result: ok('agentic') }
  const program = buildProgram(deps, state)
  try {
    await program.parseAsync([...argv])
  } catch (error) {
    if (error instanceof CommanderError) {
      const code = HELP_CODES.has(error.code) ? EXIT_OK : EXIT_USAGE
      deps.exit(code)
      return code
    }
    const result = failure('agentic', codeOf(error), messageOf(error))
    emit(deps, result, false)
    deps.exit(result.exitCode)
    return result.exitCode
  }
  deps.exit(state.result.exitCode)
  return state.result.exitCode
}
