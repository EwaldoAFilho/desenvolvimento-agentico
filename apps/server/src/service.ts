import nodeProcess from 'node:process'
import type { AdoptionResult } from '@agentic/orchestrator'
import type { ServerConfig } from './config.js'
import type { ControlPlaneRuntime } from './control-plane-file.js'
import { ControlPlaneBusyError, type ShutdownOptions } from './ownership.js'
import { startServer } from './server.js'

/**
 * Ciclo de vida do SERVICO — o processo que possui o projeto — como uma maquina de estados
 * com nome, para a CLI hoje e a extensao do editor amanha chamarem as MESMAS primitivas.
 *
 * Nao e um `RunStatus`: o run vive no banco e sobrevive ao processo; isto aqui descreve o
 * processo. Cinco estados:
 *
 *   STOPPED  ──start()──▶ STARTING ──ok──▶ RUNNING ──stop()──▶ STOPPING ──ok──▶ STOPPED
 *                            │ falha                                │ falha
 *                            ▼                                      ▼
 *                         STOPPED (nada ficou de pe)             FAILED (efeito vivo,
 *                                                                        posse retida)
 *
 * `FAILED` e o unico estado que exige acao: o encerramento venceu o prazo com efeito ainda
 * em voo, entao a posse NAO foi devolvida (I15) — `stop()` de novo tenta outra vez, e
 * `start()` recusa ate isso acontecer. Um `start()` que falha nao deixa nada para tras
 * (`startServer` devolve a posse quando quebra depois de adquiri-la), por isso volta a
 * `STOPPED` com a falha registrada.
 */
export type ServiceStatus = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'FAILED'

export interface ServiceFailure {
  readonly code?: string
  readonly message: string
  readonly at: string
}

export interface ServiceSnapshot {
  readonly status: ServiceStatus
  /** Diagnostico para o humano; a identidade e `instanceId`. */
  readonly pid: number
  /** Instante (ISO) da ultima transicao. */
  readonly since: string
  readonly instanceId?: string
  readonly url?: string
  readonly adoption?: AdoptionResult
  /** Ultima falha de `start`/`stop`; some no proximo sucesso. */
  readonly failure?: ServiceFailure
  /** Quando o `start` foi recusado por posse: o dono que ja esta no ar, se publicou endereco. */
  readonly owner?: ControlPlaneRuntime
}

/** O que o servico precisa de um control plane no ar. `RunningServer` satisfaz. */
export interface BootedControlPlane {
  readonly url: string
  readonly lease?: { readonly instanceId: string }
  readonly adoption?: AdoptionResult
  close(options?: ShutdownOptions): Promise<void>
}

export type BootFn = (config: ServerConfig) => Promise<BootedControlPlane>

export interface ControlPlaneServiceDeps {
  /** Quem sobe o control plane. Default: `startServer`. Injetavel para o teste nao abrir porta. */
  readonly boot?: BootFn
  readonly now?: () => Date
}

export interface ControlPlaneService {
  /** Sem efeito colateral: e o que a extensao consulta para desenhar o estado. */
  status(): ServiceSnapshot
  /**
   * Sobe o control plane. Idempotente: em `RUNNING` devolve o estado atual e NAO cria um
   * segundo dono; em `STARTING`, compartilha a mesma partida. Rejeita com
   * `ControlPlaneBusyError` quando outro processo ja possui o projeto (I14), e com
   * `ServiceStateError` em `FAILED`.
   */
  start(): Promise<ServiceSnapshot>
  /**
   * Encerramento gracioso (I15). Idempotente: em `STOPPED` devolve o estado; em `STOPPING`,
   * compartilha o mesmo encerramento. Rejeita — e fica em `FAILED`, com a posse retida —
   * quando algum efeito nao para dentro do prazo.
   */
  stop(options?: ShutdownOptions): Promise<ServiceSnapshot>
  /**
   * `stop` e depois `start`, serializados: a posse e devolvida DE FATO antes de o novo dono
   * disputa-la, e o novo dono adota os runs recuperaveis. Nunca dois donos.
   */
  restart(options?: ShutdownOptions): Promise<ServiceSnapshot>
  /** O control plane vivo enquanto `RUNNING`; `undefined` fora disso. */
  readonly running: BootedControlPlane | undefined
}

export class ServiceStateError extends Error {
  readonly code = 'SERVICE_STATE'
  readonly status: ServiceStatus

  constructor(status: ServiceStatus, detail: string) {
    super(`servico em ${status}: ${detail}`)
    this.name = 'ServiceStateError'
    this.status = status
  }
}

function failureOf(error: unknown, at: string): ServiceFailure {
  const code = (error as { readonly code?: unknown }).code
  return {
    ...(typeof code === 'string' ? { code } : {}),
    message: error instanceof Error ? error.message : String(error),
    at,
  }
}

export function createControlPlaneService(
  config: ServerConfig = {},
  deps: ControlPlaneServiceDeps = {},
): ControlPlaneService {
  const boot = deps.boot ?? startServer
  const now = deps.now ?? ((): Date => new Date())

  let status: ServiceStatus = 'STOPPED'
  let since = now().toISOString()
  let running: BootedControlPlane | undefined
  let failure: ServiceFailure | undefined
  let owner: ControlPlaneRuntime | undefined
  /** Fila das operacoes: `start`, `stop` e `restart` nunca se sobrepoem. */
  let chain: Promise<unknown> = Promise.resolve()
  let enfileiradas = 0
  let pendingStart: Promise<ServiceSnapshot> | undefined
  let pendingStop: Promise<ServiceSnapshot> | undefined

  const transition = (next: ServiceStatus): void => {
    status = next
    since = now().toISOString()
  }

  const snapshot = (): ServiceSnapshot => ({
    status,
    pid: nodeProcess.pid,
    since,
    ...(running === undefined
      ? {}
      : {
          url: running.url,
          ...(running.lease === undefined ? {} : { instanceId: running.lease.instanceId }),
          ...(running.adoption === undefined ? {} : { adoption: running.adoption }),
        }),
    ...(failure === undefined ? {} : { failure }),
    ...(owner === undefined ? {} : { owner }),
  })

  const doStart = async (): Promise<ServiceSnapshot> => {
    if (status === 'RUNNING') return snapshot()
    if (status === 'FAILED') {
      throw new ServiceStateError(
        status,
        'o encerramento anterior deixou efeito vivo e a posse retida; chame stop() de novo ' +
          'antes de start() (I15)',
      )
    }
    transition('STARTING')
    try {
      const booted = await boot(config)
      running = booted
      failure = undefined
      owner = undefined
      transition('RUNNING')
    } catch (error) {
      // Nada ficou de pe: quem falha depois de adquirir a posse a devolve (`startServer`).
      running = undefined
      failure = failureOf(error, 'start')
      owner = error instanceof ControlPlaneBusyError ? error.owner : undefined
      transition('STOPPED')
      throw error
    }
    return snapshot()
  }

  const doStop = async (options: ShutdownOptions): Promise<ServiceSnapshot> => {
    if (status === 'STOPPED') return snapshot()
    const alvo = running
    if (alvo === undefined) {
      transition('STOPPED')
      return snapshot()
    }
    transition('STOPPING')
    try {
      await alvo.close(options)
      running = undefined
      failure = undefined
      transition('STOPPED')
    } catch (error) {
      // `running` fica: e ele que o proximo `stop()` tenta encerrar de novo.
      failure = failureOf(error, 'stop')
      transition('FAILED')
      throw error
    }
    return snapshot()
  }

  /**
   * Com a fila vazia a operacao comeca AGORA, sincronamente ate o primeiro `await`: quem
   * chama `start()` e pergunta `status()` na linha seguinte ve `STARTING`, nao `STOPPED`.
   */
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = enfileiradas === 0 ? work() : chain.then(work)
    enfileiradas += 1
    chain = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        enfileiradas -= 1
      })
    return result
  }

  return {
    status: snapshot,
    get running(): BootedControlPlane | undefined {
      return running
    },
    start: (): Promise<ServiceSnapshot> => {
      pendingStart ??= enqueue(doStart).finally(() => {
        pendingStart = undefined
      })
      return pendingStart
    },
    stop: (options = {}): Promise<ServiceSnapshot> => {
      pendingStop ??= enqueue(() => doStop(options)).finally(() => {
        pendingStop = undefined
      })
      return pendingStop
    },
    restart: (options = {}): Promise<ServiceSnapshot> =>
      enqueue(async () => {
        await doStop(options)
        return doStart()
      }),
  }
}
