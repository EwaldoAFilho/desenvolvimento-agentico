import type { LiveControlPlane } from './discovery.js'
import type { SpawnedProcess } from './launcher.js'

/**
 * Ciclo de vida do control plane VISTO DO EDITOR.
 *
 * Nao reimplementa o `ControlPlaneService` do servidor: aquele descreve o processo que possui
 * o projeto; este descreve o que ESTA JANELA sabe e pode fazer. Os estados sao os mesmos de
 * proposito (ADR-0014), com um fato a mais — `owned`: o processo no ar foi criado por esta
 * janela (ha um handle de filho) ou por outra (outra janela, o terminal). Nos dois casos o
 * control plane e um so (I14); o que muda e a alavanca do `stop`.
 *
 *   STOPPED ──start()──▶ STARTING ──health ok──▶ RUNNING ──stop()──▶ STOPPING ──silencio──▶ STOPPED
 *                          │ falha                                      │ prazo vencido
 *                          ▼                                            ▼
 *                       STOPPED (nada ficou de pe)                   FAILED (processo vivo)
 *
 * Sinal enviado nao e processo morto: `stop()` so declara STOPPED quando o filho SAIU ou,
 * para um dono externo, quando a descoberta ficou muda. Vencido o prazo, o estado e FAILED
 * e o processo continua la — `stop()` de novo tenta outra vez.
 */
export type ServiceState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'FAILED'

export interface ServiceFailure {
  readonly at: 'start' | 'stop' | 'refresh'
  readonly message: string
}

export interface ServiceView {
  readonly state: ServiceState
  readonly live?: LiveControlPlane
  /** `true` = o processo no ar e filho desta janela. */
  readonly owned: boolean
  /** pid de um filho criado por esta janela que ainda nao saiu (dono confirmado ou nao). */
  readonly childPid?: number
  /** `true` enquanto `spawnServe()` ainda nao devolveu o processo (toolchain em resolucao). */
  readonly spawning: boolean
  readonly since: string
  readonly failure?: ServiceFailure
  /** Ultima verificacao (ISO). */
  readonly checkedAt?: string
}

export interface ServiceTimeouts {
  readonly startMs: number
  readonly stopMs: number
  readonly pollMs: number
}

export const DEFAULT_TIMEOUTS: ServiceTimeouts = { startMs: 60_000, stopMs: 30_000, pollMs: 250 }

export interface ServiceDeps {
  discover(): Promise<LiveControlPlane | undefined>
  /** Resolve toolchain e sobe `agentic serve`. Rejeita quando nem da para tentar. */
  spawnServe(): Promise<SpawnedProcess>
  /** Sinal a um processo que NAO e filho desta janela. `false` = nao entregue. */
  signal(pid: number, signal: 'SIGTERM'): boolean
  sleep(ms: number): Promise<void>
  now(): Date
  log(line: string): void
  readonly timeouts?: Partial<ServiceTimeouts>
}

export class ServiceStateError extends Error {
  readonly code = 'SERVICE_STATE'
  readonly state: ServiceState

  constructor(state: ServiceState, detail: string) {
    super(`control plane em ${state}: ${detail}`)
    this.name = 'ServiceStateError'
    this.state = state
  }
}

export type Listener = (view: ServiceView) => void

export class AgenticService {
  private state: ServiceState = 'STOPPED'
  private since: string
  private live: LiveControlPlane | undefined
  private child: SpawnedProcess | undefined
  /** O spawn em voo: conhecido desde ANTES de haver pid, para o encerramento nao o perder. */
  private spawning: Promise<SpawnedProcess> | undefined
  /**
   * Ligado por `stopOwnChild()`: nenhum filho desta janela pode sobreviver a partir daqui. Um
   * spawn que resolva depois encontra a bandeira e o recem-nascido recebe SIGTERM na hora.
   */
  private abandoned = false
  private failure: ServiceFailure | undefined
  private checkedAt: string | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private pendingStart: Promise<ServiceView> | undefined
  private pendingStop: Promise<ServiceView> | undefined
  private readonly listeners = new Set<Listener>()
  private readonly timeouts: ServiceTimeouts
  private readonly deps: ServiceDeps

  constructor(deps: ServiceDeps) {
    this.deps = deps
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...(deps.timeouts ?? {}) }
    this.since = deps.now().toISOString()
  }

  view(): ServiceView {
    return {
      state: this.state,
      owned: this.ownsLive(),
      since: this.since,
      spawning: this.spawning !== undefined,
      ...(this.child !== undefined && !this.child.done ? { childPid: this.child.pid } : {}),
      ...(this.live === undefined ? {} : { live: this.live }),
      ...(this.failure === undefined ? {} : { failure: this.failure }),
      ...(this.checkedAt === undefined ? {} : { checkedAt: this.checkedAt }),
    }
  }

  onDidChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Reconsulta a descoberta sem efeito colateral. Nao interrompe uma operacao em voo. */
  refresh(): Promise<ServiceView> {
    if (this.state === 'STARTING' || this.state === 'STOPPING') return Promise.resolve(this.view())
    return this.enqueue(async () => {
      if (this.state === 'STARTING' || this.state === 'STOPPING') return this.view()
      await this.observe()
      return this.view()
    })
  }

  /** Reutiliza o dono que existir; so sobe um novo no silencio. */
  ensureRunning(): Promise<ServiceView> {
    return this.start()
  }

  /** Idempotente: em RUNNING devolve o estado; chamadas concorrentes compartilham a mesma partida. */
  start(): Promise<ServiceView> {
    this.pendingStart ??= this.enqueue(() => this.doStart()).finally(() => {
      this.pendingStart = undefined
    })
    return this.pendingStart
  }

  /** Idempotente: em STOPPED devolve o estado; chamadas concorrentes compartilham o mesmo encerramento. */
  stop(): Promise<ServiceView> {
    this.pendingStop ??= this.enqueue(() => this.doStop()).finally(() => {
      this.pendingStop = undefined
    })
    return this.pendingStop
  }

  /** `stop` e depois `start`, serializados: nunca dois donos. */
  restart(): Promise<ServiceView> {
    return this.enqueue(async () => {
      const stopped = await this.doStop()
      if (stopped.state !== 'STOPPED') {
        throw new ServiceStateError(
          stopped.state,
          'restart interrompido: o control plane anterior nao encerrou',
        )
      }
      return this.doStart()
    })
  }

  private async doStart(): Promise<ServiceView> {
    // Fast-path: um control plane conhecido no ar nao e disputado de novo. Uma falha
    // transitoria do health nao pode virar um segundo `serve` substituindo o handle do filho.
    if (this.state === 'RUNNING' && (this.ownsLive() || this.child === undefined))
      return this.view()
    if (this.state === 'FAILED') {
      throw new ServiceStateError(
        this.state,
        'o encerramento anterior nao terminou e o processo continua vivo; chame stop() de novo antes de start()',
      )
    }
    this.transition('STARTING')
    const existing = await this.deps.discover()
    if (existing !== undefined) {
      this.deps.log(`control plane ja no ar em ${existing.url}; reutilizando (I14)`)
      this.adopt(existing)
      return this.view()
    }
    if (this.abandoned) {
      this.transition('STOPPED')
      return this.view()
    }
    let child: SpawnedProcess
    try {
      this.spawning = this.deps.spawnServe()
      child = await this.spawning
    } catch (error) {
      this.spawning = undefined
      this.fail('start', messageOf(error))
      this.transition('STOPPED')
      return this.view()
    }
    this.spawning = undefined
    this.child = child
    if (this.abandoned) {
      // O encerramento da janela chegou enquanto a toolchain resolvia. O filho nasceu; nao
      // fica: SIGTERM agora, com a saida provada — nunca um orfao sem dono na extensao.
      this.deps.log(`spawn assentou apos o encerramento da janela (pid ${child.pid}); encerrando`)
      await this.terminateOwnChild(child)
      this.transition(this.child === undefined ? 'STOPPED' : 'FAILED')
      return this.view()
    }
    this.deps.log(`agentic serve iniciado (pid ${child.pid}); aguardando /api/health`)
    const deadline = this.deps.now().getTime() + this.timeouts.startMs
    let exitedZeroAt: number | undefined
    for (;;) {
      if (this.abandoned) {
        await this.terminateOwnChild(child)
        this.transition(this.child === undefined ? 'STOPPED' : 'FAILED')
        return this.view()
      }
      const live = await this.deps.discover()
      // A bandeira pode ter sido ligada DURANTE a sondagem: o resultado dela nao adota nada.
      if (this.abandoned) {
        await this.terminateOwnChild(child)
        this.transition(this.child === undefined ? 'STOPPED' : 'FAILED')
        return this.view()
      }
      if (live !== undefined && live.pid === child.pid) {
        this.adopt(live)
        this.deps.log(`control plane no ar em ${live.url} (pid ${live.pid})`)
        return this.view()
      }
      if (live !== undefined) {
        // Outro processo venceu a corrida (outra janela, o terminal). O nosso filho e o
        // perdedor: assenta ele PRIMEIRO, para nunca haver dois handles vivos, e so entao
        // adota o vencedor.
        await this.settleLoser(child)
        this.deps.log(`ha dono em ${live.url} (pid ${live.pid ?? '?'}); reutilizando`)
        this.adopt(live)
        return this.view()
      }
      if (child.done) {
        const exit = await child.exited
        if (exit.code === 0) {
          // Saida 0 sem publicar = "ja havia dono": o vencedor pode ainda nao ter publicado
          // o endereco. Espera-se por ele ate o prazo, nao por uma unica consulta.
          exitedZeroAt ??= this.deps.now().getTime()
          if (this.deps.now().getTime() - exitedZeroAt < this.timeouts.stopMs) {
            await this.deps.sleep(this.timeouts.pollMs)
            continue
          }
        }
        this.child = undefined
        this.fail(
          'start',
          `agentic serve encerrou (${describeExit(exit)}) sem publicar o control plane:\n${child.output()}`,
        )
        this.transition('STOPPED')
        return this.view()
      }
      if (this.deps.now().getTime() > deadline) {
        // Sinal enviado nao e processo morto: sem a saida provada, o handle fica e o estado
        // e FAILED — o mesmo contrato do stop().
        child.kill('SIGTERM')
        const ended = await this.waitUntil(() => child.done, this.timeouts.stopMs)
        if (!ended) {
          this.fail(
            'start',
            `agentic serve (pid ${child.pid}) nao publicou /api/health em ${this.timeouts.startMs}ms e nao saiu apos SIGTERM; ` +
              `processo mantido (Stop de novo tenta outra vez):\n${child.output()}`,
          )
          this.transition('FAILED')
          return this.view()
        }
        this.child = undefined
        this.fail(
          'start',
          `agentic serve nao publicou /api/health em ${this.timeouts.startMs}ms:\n${child.output()}`,
        )
        this.transition('STOPPED')
        return this.view()
      }
      await this.deps.sleep(this.timeouts.pollMs)
    }
  }

  /**
   * Encerramento da JANELA: para somente o que ela criou, e nunca toca um dono externo.
   *
   * Nao entra na fila: um `start()` em voo pode estar esperando a toolchain ou o health por
   * ate `startMs`, e o host da extensao da poucos segundos ao `deactivate`. A bandeira
   * `abandoned` e lida pelo `doStart` a cada volta (e logo depois do spawn assentar), entao
   * o filho — nascido ou por nascer — recebe SIGTERM de dentro do proprio `start`. Aqui so
   * se espera, com prazo, e se relata o que foi provado.
   */
  async stopOwnChild(): Promise<'none' | 'stopped' | 'retained'> {
    this.abandoned = true
    const pending = this.pendingStart
    if (pending !== undefined) {
      // O start em voo e quem encerra o filho (bandeira). Espera-se por ele; o prazo e de
      // quem chama (o `deactivate` corre contra o proprio relogio), e a bandeira continua
      // valendo mesmo se esse prazo vencer antes.
      await pending.catch(() => undefined)
      // O start pode ter adotado o filho num instante em que a bandeira ainda nao valia
      // (a sondagem ja estava em voo): o que sobrou vivo e nosso e e encerrado aqui.
    }
    const child = this.child
    if (child === undefined || child.done) {
      this.child = undefined
      return 'none'
    }
    await this.terminateOwnChild(child)
    if (this.child !== undefined) return 'retained'
    if (this.live?.pid === child.pid) this.live = undefined
    if (this.live === undefined) this.transition('STOPPED')
    return 'stopped'
  }

  /** SIGTERM ao NOSSO filho e espera pela saida provada; sem prova, o handle fica. */
  private async terminateOwnChild(child: SpawnedProcess): Promise<void> {
    if (!child.done) {
      child.kill('SIGTERM')
      const ended = await this.waitUntil(() => child.done, this.timeouts.stopMs)
      if (!ended) {
        this.deps.log(`filho (pid ${child.pid}) nao saiu apos SIGTERM; handle mantido`)
        return
      }
    }
    if (this.child === child) this.child = undefined
    if (this.live?.pid === child.pid) this.live = undefined
  }

  /**
   * O filho que perdeu a disputa sai sozinho com 0 ("ja havia dono"). Se nao sair, recebe
   * SIGTERM; se ainda assim ficar, o handle e mantido em `child` e aparece em `childPid` —
   * nunca e esquecido. Em nenhum caso o dono real e tocado.
   */
  private async settleLoser(child: SpawnedProcess): Promise<void> {
    if (await this.waitUntil(() => child.done, this.timeouts.stopMs)) {
      this.child = undefined
      return
    }
    child.kill('SIGTERM')
    if (await this.waitUntil(() => child.done, this.timeouts.stopMs)) {
      this.child = undefined
      return
    }
    this.deps.log(`filho perdedor (pid ${child.pid}) nao saiu; handle mantido`)
  }

  private async doStop(): Promise<ServiceView> {
    if (this.state === 'STOPPED') return this.view()
    this.transition('STOPPING')
    const child = this.child
    if (child !== undefined && !child.done) {
      this.deps.log(
        `SIGTERM ao control plane desta janela (pid ${child.pid}); aguardando encerramento gracioso`,
      )
      child.kill('SIGTERM')
      const ended = await this.waitUntil(() => child.done, this.timeouts.stopMs)
      if (!ended) {
        this.fail(
          'stop',
          `o control plane (pid ${child.pid}) nao encerrou em ${this.timeouts.stopMs}ms; ` +
            'a posse continua com ele (I15). Stop de novo tenta outra vez.',
        )
        this.transition('FAILED')
        return this.view()
      }
      this.child = undefined
      // O filho saiu; mas o control plane no ar pode ser OUTRO (o filho era um perdedor).
      // STOPPED so quando a descoberta esta muda.
      const remaining = await this.deps.discover()
      if (remaining !== undefined) {
        this.deps.log(
          `filho encerrado, mas ha dono em ${remaining.url} (pid ${remaining.pid ?? '?'}); continua RUNNING`,
        )
        this.adopt(remaining)
        return this.view()
      }
      this.live = undefined
      this.failure = undefined
      this.transition('STOPPED')
      this.deps.log('control plane encerrado')
      return this.view()
    }
    this.child = undefined
    const live = await this.deps.discover()
    if (live === undefined) {
      this.live = undefined
      this.failure = undefined
      this.transition('STOPPED')
      return this.view()
    }
    if (live.pid === undefined) {
      this.fail(
        'stop',
        `ha um control plane em ${live.url} sem registro de processo; encerre-o pelo terminal (Ctrl+C no \`agentic serve\`)`,
      )
      this.transition('FAILED')
      return this.view()
    }
    this.deps.log(`SIGTERM ao control plane externo (pid ${live.pid}, ${live.url})`)
    if (!this.deps.signal(live.pid, 'SIGTERM')) {
      this.fail('stop', `nao foi possivel sinalizar o processo ${live.pid}`)
      this.transition('FAILED')
      return this.view()
    }
    const silent = await this.waitUntil(
      async () => (await this.deps.discover()) === undefined,
      this.timeouts.stopMs,
    )
    if (!silent) {
      this.fail(
        'stop',
        `o control plane (pid ${live.pid}) ainda responde apos ${this.timeouts.stopMs}ms; Stop de novo tenta outra vez`,
      )
      this.transition('FAILED')
      return this.view()
    }
    this.live = undefined
    this.failure = undefined
    this.transition('STOPPED')
    this.deps.log('control plane externo encerrado')
    return this.view()
  }

  private async observe(): Promise<void> {
    if (this.child?.done === true) this.child = undefined
    const live = await this.deps.discover()
    this.checkedAt = this.deps.now().toISOString()
    if (live !== undefined) {
      if (this.state !== 'RUNNING' || this.live?.url !== live.url || this.live?.pid !== live.pid) {
        this.adopt(live)
      } else {
        this.live = live
      }
      return
    }
    if (this.state === 'FAILED' && this.child !== undefined) return
    this.live = undefined
    if (this.state !== 'STOPPED') this.transition('STOPPED')
  }

  private adopt(live: LiveControlPlane): void {
    this.live = live
    this.failure = undefined
    this.checkedAt = this.deps.now().toISOString()
    if (this.child !== undefined && live.pid !== this.child.pid) {
      // O que esta no ar nao e o nosso filho: ou ele saiu, ou nunca virou dono.
      if (this.child.done) this.child = undefined
    }
    this.transition('RUNNING')
  }

  private ownsLive(): boolean {
    return this.child !== undefined && !this.child.done && this.live?.pid === this.child.pid
  }

  private fail(at: ServiceFailure['at'], message: string): void {
    this.failure = { at, message }
    this.deps.log(`falha em ${at}: ${message}`)
  }

  private transition(next: ServiceState): void {
    this.state = next
    this.since = this.deps.now().toISOString()
    const view = this.view()
    for (const listener of this.listeners) listener(view)
  }

  private async waitUntil(
    condition: () => boolean | Promise<boolean>,
    maxMs: number,
  ): Promise<boolean> {
    const deadline = this.deps.now().getTime() + maxMs
    for (;;) {
      if (await condition()) return true
      if (this.deps.now().getTime() > deadline) return false
      await this.deps.sleep(this.timeouts.pollMs)
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work)
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function describeExit(exit: {
  readonly code: number | null
  readonly signal: string | null
}): string {
  return exit.signal === null ? `codigo ${exit.code ?? '?'}` : `sinal ${exit.signal}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
