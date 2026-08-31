import { startServer } from '@agentic/server'
import { loadProjectContext } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { describeEndpoint, resolveEndpoint } from '../discovery.js'
import { createOutput } from '../output.js'
import { type CommandResult, failure, ok } from '../result.js'

export interface ServeArgs {
  readonly port?: number
  readonly project?: string
  readonly json?: boolean
}

export interface ServeData {
  readonly endpoint: string
  readonly running: boolean
  readonly reason?: string
}

/** Entrada equivalente publicada pelo proprio pacote do servidor. */
export const SERVER_COMMAND = 'npm start -w @agentic/server'

/**
 * `serve` sobe o control plane SEM run ativo — e o que permite dar START MISSION pelo
 * dashboard (ARCHITECTURE 4).
 *
 * A dependencia cli -> server e entre interfaces: nao ha ciclo (o servidor nao conhece a
 * CLI) e o dominio nao e tocado. `bootServer` e injetavel para o teste nao abrir porta.
 */
export async function serveCommand(args: ServeArgs, deps: CommandDeps): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const context = await loadProjectContext(deps, args)
  // Um control plane em porta diferente da declarada continua sendo um control plane: quem
  // manda e o registro de runtime do processo vivo, nao o endereco desejado.
  const resolved = await resolveEndpoint(
    context,
    args.port === undefined ? {} : { port: args.port },
  )
  const endpoint = resolved.endpoint

  const existing = await deps.connect(endpoint)
  if (existing !== undefined) {
    out.line(`control plane ja no ar em ${describeEndpoint(resolved)}`)
    out.line('nada a fazer: START MISSION pelo dashboard ou `agentic mission start`.')
    return ok('serve', { endpoint, running: true } satisfies ServeData)
  }

  const boot = deps.bootServer ?? startServer
  try {
    const running = await boot({
      repoRoot: context.repoRoot,
      projectFile: context.projectPath,
      runtimeDir: context.baseDir,
      ...(args.port === undefined ? {} : { port: args.port }),
    })
    out.line(`control plane no ar em ${running.url}`)
    out.line(`host/porta vem de \`server\` em ${context.projectPath}`)
    out.line('endereco publicado em .agentic/control-plane.json enquanto este processo viver')
    out.line()
    out.line('sem run ativo: use START MISSION no dashboard ou `agentic mission start`.')
    await deps.waitForShutdown()
    await running.close()
    return ok('serve', { endpoint: running.url, running: true } satisfies ServeData)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    out.line(`nao foi possivel subir o control plane em ${endpoint}`)
    out.line(reason)
    out.line()
    out.line(`alternativa: ${SERVER_COMMAND}`)
    return failure('serve', 'SERVER_UNAVAILABLE', reason, {
      endpoint,
      running: false,
      reason,
    } satisfies ServeData)
  }
}
