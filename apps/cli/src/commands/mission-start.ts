import type { ControlPlane } from '@agentic/orchestrator'
import { compileMission, hasSeverity, toCompileReport } from '@agentic/orchestrator'
import { acquireControlPlaneOwnership } from '@agentic/persistence'
import { StartRunCommandSchema } from '@agentic/schemas'
import { shutdownControlPlane } from '@agentic/server'
import {
  compileInputOf,
  loadProjectContext,
  type ProjectContext,
  readMissionFile,
} from '../context.js'
import type { BootedServer, CommandDeps } from '../deps.js'
import { renderDiagnostics } from '../diagnostics.js'
import { discoverRuntime, resolveEndpoint } from '../discovery.js'
import { superviseForeground } from '../foreground.js'
import type { ControlPlaneLink } from '../link.js'
import { createOutput, type Output } from '../output.js'
import { findMissionRun, openPlane } from '../plane.js'
import { type CommandResult, failure, messageOf, ok, usageError } from '../result.js'
import type { MissionFileArgs } from './mission-validate.js'

export interface StartArgs extends MissionFileArgs {
  readonly actor?: string
  readonly acceptWarnings?: boolean
  /**
   * `undefined` (default) publica a API e encerra quando o run termina. `true` publica e
   * MANTEM o control plane no ar depois do fim (Ctrl+C encerra). `false` (`--no-serve`) nao
   * publica HTTP: o run fica inalcancavel por pause/resume/stop.
   */
  readonly serve?: boolean
  readonly port?: number
}

/** Depois destes, nao ha mais o que comandar: o run acabou. */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELLED'])

export interface StartData {
  /** Ausente quando o START foi entregue a um control plane remoto. */
  readonly runId?: string
  readonly missionId: string
  readonly status: string
  readonly warningsAccepted: boolean
  readonly tasks?: Record<string, number>
  readonly deliveredTo?: string
  /** Endereco publicado por ESTE processo, quando publicou. */
  readonly servedAt?: string
}

/**
 * Sobe a API sobre o plane deste processo. Falhar aqui NAO derruba o run: o run e o
 * produto, a porta e conveniencia — mas o usuario precisa saber que ficou sem ela.
 */
async function publishApi(
  deps: CommandDeps,
  context: ProjectContext,
  plane: ControlPlane,
  out: Output,
  port?: number,
  instanceId?: string,
): Promise<BootedServer | undefined> {
  const serve = deps.servePlane
  if (serve === undefined) return undefined
  try {
    return await serve({
      plane,
      project: context.project,
      projectText: context.projectText,
      gatesText: context.gatesText,
      // O `repoRoot` e tudo o que o servidor precisa: o diretorio de estado onde ele
      // publica a descoberta e DERIVADO dele, pela mesma conta que a posse usa.
      repoRoot: context.repoRoot,
      ...(port === undefined ? {} : { port }),
      ...(instanceId === undefined ? {} : { instanceId }),
    })
  } catch (error) {
    out.warn(`API HTTP indisponivel: ${messageOf(error)}`)
    return undefined
  }
}

export function actorOf(args: { readonly actor?: string }, deps: CommandDeps): string {
  const declared = args.actor?.trim()
  if (declared !== undefined && declared.length > 0) return declared
  const user = deps.env.USER ?? deps.env.USERNAME
  return user === undefined || user.length === 0 ? 'humano' : user
}

/**
 * `mission start`: cria o Run e orquestra. Recusa missao nao aprovada, recusa ERROR e
 * exige aceite explicito quando ha WARNING (ARCHITECTURE 4.1, DASHBOARD 2.1).
 */
export async function missionStartCommand(
  args: StartArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const context = await loadProjectContext(deps, args)
  const mission = await readMissionFile(deps, args.file)
  const acceptWarnings = args.acceptWarnings === true
  const actor = actorOf(args, deps)

  const command = StartRunCommandSchema.safeParse({
    missionPath: mission.path,
    acceptWarnings,
    actor,
  })
  if (!command.success) {
    throw usageError(
      `start recusado: ${command.error.issues.map((issue) => issue.message).join('; ')}`,
      'INVALID_START',
    )
  }

  const result = compileMission(compileInputOf(context, mission))
  const report = toCompileReport(result, mission.text)
  if (!report.ok) {
    out.lines(renderDiagnostics(result.diagnostics))
    return failure(
      'mission start',
      'VALIDATION_FAILED',
      'missao com diagnostico ERROR nao inicia (P01)',
      report,
    )
  }

  /** START entregue a quem ja e dono: a CLI nao abre um segundo escritor (I7, I14). */
  const entregar = async (endpoint: string, link: ControlPlaneLink): Promise<CommandResult> => {
    await link.send({ method: 'POST', path: '/api/runs', body: command.data })
    out.line(`START MISSION entregue ao control plane em ${endpoint}`)
    const remote: StartData = {
      missionId: report.missionId,
      status: 'RUNNING',
      warningsAccepted: acceptWarnings,
      deliveredTo: endpoint,
    }
    return ok('mission start', remote)
  }

  const resolved = await resolveEndpoint(
    context,
    args.port === undefined ? {} : { port: args.port },
  )
  const link = await deps.connect(resolved.endpoint, { repoRoot: context.repoRoot })
  if (link !== undefined) return entregar(link.endpoint, link)

  /**
   * Ninguem atendeu no endereco tentado — mas orquestrar em primeiro plano e ser DONO do
   * projeto, e dono so ha um (I14). A posse e disputada aqui, antes de abrir banco.
   *
   * Perder a disputa nao e erro: significa que existe um dono que este comando nao alcancou
   * pelo endereco tentado (o caso classico e `--port` divergente). Entao a descoberta e
   * consultada SEM a flag e o START vai para o dono de verdade.
   */
  /**
   * O tratador do encerramento existe ANTES do primeiro recurso cuja devolucao depende dele:
   * a posse. Entre adquiri-la e o supervisor comecar ha `open`, `startRun` e `plane.open()`
   * (que roda git), e um sinal nessa janela caia no tratador padrao do Node — processo morto,
   * lock solto pelo SO, git ainda rodando. O sinal que chegar durante o bootstrap e atendido
   * pelo mesmo lifecycle, logo que o supervisor o ve.
   */
  const shutdown = deps.waitForShutdown()
  const posse = acquireControlPlaneOwnership({ baseDir: context.runtimeDir })
  if (!posse.ok) {
    const dono = await discoverRuntime(context)
    const outro =
      dono === undefined ? undefined : await deps.connect(dono.url, { repoRoot: context.repoRoot })
    if (outro !== undefined) return entregar(outro.endpoint, outro)
    return failure(
      'mission start',
      'OWNERSHIP_ALREADY_HELD',
      [
        `outro control plane ja possui ${posse.ownedDir} e nao respondeu em ${resolved.endpoint}.`,
        'um projeto tem um dono so: este comando nao vai abrir um segundo (I14).',
        'descubra o endereco em .agentic/control-plane.json, ou encerre o control plane no ar.',
      ].join('\n'),
    )
  }

  // Amarrado aqui de proposito: dentro da funcao abaixo o compilador ja nao sabe que a
  // disputa foi vencida, e a posse precisa ser a MESMA em todo o comando.
  const lease = posse.lease
  return missionStartLocal()

  /**
   * Orquestra em primeiro plano e encerra pela MESMA primitiva de `agentic serve` e do
   * servico (`shutdownControlPlane`): para de atender, drena os efeitos, fecha o banco e so
   * entao devolve a posse (I15). Antes, o `finally` soltava a posse mesmo quando o `close`
   * do plane falhava — isto e, com efeito ainda vivo.
   */
  async function missionStartLocal(): Promise<CommandResult> {
    const plane = openPlane(deps, context, lease)
    let published: BootedServer | undefined
    const encerrar = (): Promise<void> =>
      shutdownControlPlane({
        stopAccepting: () => plane.quiesce(),
        stopServing: async (): Promise<void> => {
          await published?.close()
        },
        stopEffects: (options) => plane.close(options),
        releaseOwnership: () => lease.release(),
      })

    /**
     * Encerrou sem devolver o projeto (efeito em voo dentro do prazo)? Entao NAO sair: sair
     * soltaria o lock pelo sistema operacional com o efeito vivo (I15). O processo fica, diz o
     * que houve, e o proximo sinal tenta de novo. Vale para o caminho normal E para o
     * excepcional: uma falha da orquestracao nao autoriza descartar a falha do encerramento.
     */
    const encerrarAteConseguir = async (): Promise<void> => {
      for (;;) {
        try {
          await encerrar()
          return
        } catch (error) {
          out.line()
          out.line(`o control plane nao encerrou limpo: ${messageOf(error)}`)
          out.line('a posse do projeto continua com este processo; Ctrl+C de novo tenta outra vez.')
          await deps.waitForShutdown()
        }
      }
    }

    let result: CommandResult
    try {
      result = await orquestrar(plane, (server) => {
        published = server
      })
    } catch (error) {
      // O erro original e o que o chamador ve — mas so DEPOIS de o projeto ser devolvido.
      await encerrarAteConseguir()
      throw error
    }
    await encerrarAteConseguir()
    return result
  }

  async function orquestrar(
    plane: ControlPlane,
    onPublished: (server: BootedServer) => void,
  ): Promise<CommandResult> {
    {
      const run = await findMissionRun(plane, report.missionId, report.specHash)
      if (run === undefined) {
        return failure(
          'mission start',
          'NOT_APPROVED',
          `missao ${report.missionId} nao tem run aprovado para este specHash; rode \`agentic mission approve ${args.file} --actor <nome>\``,
        )
      }
      if (run.status !== 'APPROVED') {
        return failure(
          'mission start',
          'NOT_APPROVED',
          `run ${run.id} esta ${run.status}: START MISSION exige APPROVED (P01)`,
          { runId: run.id, missionId: run.missionId, status: run.status },
        )
      }
      if (hasSeverity(report.diagnostics, 'WARNING') && !acceptWarnings) {
        out.lines(renderDiagnostics(result.diagnostics))
        return failure(
          'mission start',
          'WARNINGS_NOT_ACCEPTED',
          `${report.stats.warnings} WARNING pendente(s): a partida exige --accept-warnings`,
          report,
        )
      }

      const started = await plane.startRun({
        runId: run.id,
        actor,
        acceptWarnings,
        diagnostics: report.diagnostics,
      })
      out.line(`run ${started.id} iniciado (${started.missionId})`)
      out.line(`  actor             ${actor}`)
      out.line(`  warnings aceitos  ${acceptWarnings ? 'sim' : 'nao'}`)
      out.line()

      const orchestrator = await plane.open(started.id)

      // MESMO plane: publicar a API sobre um segundo control plane abriria um segundo escritor
      // no mesmo banco (I7). Publicar e o DEFAULT — sem porta, `mission pause` nao teria a quem
      // falar, e a unica saida do usuario seria Ctrl+C.
      const published =
        args.serve === false
          ? undefined
          : await publishApi(deps, context, plane, out, args.port, lease.instanceId)
      if (published !== undefined) onPublished(published)

      if (published === undefined) {
        // Sem porta: pause, resume, stop, retry, unblock e skip nao alcancam este run enquanto
        // ele anda. Dizer isso ANTES e mais barato que descobrir na hora.
        out.line(
          'modo primeiro plano SEM API HTTP: este run nao pode ser comandado de outro terminal.',
        )
        if (args.serve === false) {
          out.line(
            `rode \`agentic mission start ${args.file}\` sem \`--no-serve\` (o default publica a API),`,
          )
          out.line('use `--serve` para manter o control plane no ar depois do fim do run, ou deixe')
          out.line('um `agentic serve` no ar antes do start. Ctrl+C encerra.')
        } else {
          // Ninguem pediu para ficar sem porta: a API era o default e nao subiu. Mandar tirar
          // uma flag que o usuario nao usou seria conselho falso — a causa esta no aviso acima.
          out.line('nao e questao de flag: `--serve` e `--no-serve` nao mudam isto. A API era o')
          out.line('default e nao subiu (motivo no aviso acima). Libere a porta, escolha outra com')
          out.line('`--port <n>` ou deixe um `agentic serve` no ar antes do start. Ctrl+C encerra.')
        }
        out.line()
      } else {
        out.line(`control plane em primeiro plano; API e dashboard em ${published.url}`)
        out.line('`agentic mission pause` e os demais comandos de mutacao alcancam este run.')
        out.line(
          args.serve === true
            ? '--serve: o control plane fica no ar mesmo depois do fim do run; Ctrl+C encerra.'
            : 'o processo encerra quando o run termina; pausado, continua no ar esperando resume.',
        )
        out.line()
      }

      if (args.serve === true) {
        // `--serve` e "fica em primeiro plano ate Ctrl+C", com ou sem porta: nao encerra
        // sozinho quando o run termina.
        orchestrator.start()
        await shutdown
        orchestrator.stop()
      } else {
        // Pausado NAO e fim: o processo segue no ar para que `resume` tenha a quem falar.
        await superviseForeground(orchestrator, {
          waitForShutdown: () => shutdown,
          ...(deps.pausePollMs === undefined ? {} : { pollMs: deps.pausePollMs }),
          onPaused: () => {
            out.line('run PAUSED: nada novo sera despachado; o control plane continua no ar.')
            out.line(`retome com \`agentic mission resume ${started.id}\`. Ctrl+C encerra.`)
          },
          onResumed: () => {
            out.line(`run ${started.id} retomado.`)
          },
        })
      }
      // A API fecha no encerramento, junto com o plane e a posse — na ordem certa.
      const snapshot = await plane.getRunSnapshot(started.id)
      out.line(`status final: ${snapshot.run.status}`)
      out.line(
        `tasks: ${snapshot.counters.DONE} DONE · ${snapshot.counters.FAILED} FAILED · ${snapshot.counters.BLOCKED} BLOCKED · ${snapshot.counters.SKIPPED} SKIPPED`,
      )
      if (!TERMINAL_RUN_STATUSES.has(snapshot.run.status)) {
        // O run nao acabou, o processo sim: dizer como voltar a comandar e mais barato que
        // deixar o usuario descobrir que a porta caiu junto.
        out.line()
        out.line(`run ${snapshot.run.id} nao terminou e este processo esta saindo.`)
        out.line('para comanda-lo de novo: `agentic serve` e depois `agentic task unblock`,')
        out.line('`agentic mission resume` ou `agentic mission stop`.')
      }
      const data: StartData = {
        runId: snapshot.run.id,
        missionId: snapshot.run.missionId,
        status: snapshot.run.status,
        warningsAccepted: acceptWarnings,
        tasks: { ...snapshot.counters },
        ...(published === undefined ? {} : { servedAt: published.url }),
      }
      if (snapshot.run.status === 'FAILED') {
        return failure(
          'mission start',
          'RUN_FAILED',
          `run ${snapshot.run.id} terminou FAILED`,
          data,
        )
      }
      return ok('mission start', data)
    }
  }
}
