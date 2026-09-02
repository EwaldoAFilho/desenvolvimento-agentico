import { createControlPlaneService } from '@agentic/server'
import { loadProjectContext } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { describeEndpoint, discoverRuntime, resolveEndpoint } from '../discovery.js'
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
  /** `true` = este comando NAO subiu nada: ja havia dono e ele foi reaproveitado (I14). */
  readonly reused?: boolean
  readonly reason?: string
}

/**
 * A recusa por posse nao e falha: e a resposta certa. Reconhecida pelo codigo, nao pela
 * classe, para que o teste possa injetar um `bootServer` que a simule sem montar servidor.
 */
function posseDeOutro(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'OWNERSHIP_ALREADY_HELD'
  )
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

  const existing = await deps.connect(endpoint, { repoRoot: context.repoRoot })
  if (existing !== undefined) {
    out.line(`control plane ja no ar em ${describeEndpoint(resolved)}`)
    out.line('nada a fazer: START MISSION pelo dashboard ou `agentic mission start`.')
    return ok('serve', { endpoint, running: true } satisfies ServeData)
  }

  /**
   * O ciclo de vida do processo e o do SERVICO (STABILITY-SLICE-004): `start` disputa a
   * posse e sobe; SIGINT/SIGTERM viram `stop`, que e a MESMA primitiva de encerramento que
   * o `agentic-server` e o futuro Stop da extensao usam — parar de atender, drenar os
   * efeitos, fechar o banco e so entao devolver o projeto (I15).
   */
  const service = createControlPlaneService(
    {
      // Onde PROCURAR o projeto. O diretorio de estado — posse, `state.db` e descoberta —
      // o servidor deriva sozinho, pela mesma conta que `mission start` e `mission approve`
      // usam; nao ha como um chamador aponta-lo para outro lugar (I14).
      repoRoot: context.repoRoot,
      projectFile: context.projectPath,
      ...(args.port === undefined ? {} : { port: args.port }),
    },
    deps.bootServer === undefined ? {} : { boot: deps.bootServer },
  )
  let url = endpoint
  // Assinado ANTES de subir: a adocao no boot ja despacha agente, e um sinal nessa janela
  // nao pode cair no tratador padrao do Node. Chegando durante o boot, ele e atendido logo
  // depois — pelo mesmo `stop`.
  const shutdown = deps.waitForShutdown()
  try {
    const running = await service.start()
    url = running.url ?? endpoint
    out.line(`control plane no ar em ${url}`)
    out.line(`host/porta vem de \`server\` em ${context.projectPath}`)
    out.line('endereco publicado em .agentic/control-plane.json enquanto este processo viver')
    out.line()
    out.line('sem run ativo: use START MISSION no dashboard ou `agentic mission start`.')
    await shutdown
  } catch (error) {
    if (posseDeOutro(error)) {
      // Este projeto ja tem dono. A descoberta e consultada SEM a flag de porta de proposito:
      // `--port` diz onde ESTE processo queria atender, e o que interessa agora e onde o dono
      // REAL esta. Foi exatamente por essa flag que dois control planes coexistiam (D4/D7).
      const dono = await discoverRuntime(context)
      const url = dono?.url ?? endpoint
      out.line(`control plane ja no ar em ${url}${dono === undefined ? '' : ` (pid ${dono.pid})`}`)
      if (args.port !== undefined) {
        out.line('este projeto ja tem dono: `--port` nao cria um segundo control plane.')
      }
      if (dono === undefined) {
        out.line('o dono ainda nao publicou o endereco; tente de novo em instantes.')
      }
      out.line('nada a fazer: START MISSION pelo dashboard ou `agentic mission start`.')
      return ok('serve', { endpoint: url, running: true, reused: true } satisfies ServeData)
    }
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

  /**
   * Encerramento gracioso. Se algum efeito nao parar dentro do prazo, a posse NAO e devolvida
   * (I15) — e este comando NAO sai: sair soltaria o lock pelo sistema operacional com o
   * efeito ainda vivo, que e o que a regra proibe. O processo fica, diz o que houve, e o
   * proximo sinal tenta de novo. `kill -9` continua sendo a saida de quem sabe o que faz.
   */
  for (;;) {
    try {
      await service.stop()
      return ok('serve', { endpoint: url, running: true } satisfies ServeData)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      out.line('o control plane nao encerrou limpo:')
      out.line(reason)
      out.line('a posse do projeto continua com este processo; Ctrl+C de novo tenta outra vez.')
      await deps.waitForShutdown()
    }
  }
}
