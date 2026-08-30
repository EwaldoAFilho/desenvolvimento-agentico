import type { AgentHandle, AgentLogEvent } from '@agentic/domain'
import { describeError } from './errors.js'
import { redactLogText } from './redact.js'

/** ARCHITECTURE 6.1: o log do executor mora no diretorio da tentativa. */
export const AGENT_LOG_FILE = 'agent.log.jsonl'
/** A revisao e outro agente na MESMA tentativa: arquivo proprio, senao sobrescreveria o log do executor. */
export const REVIEW_LOG_FILE = 'review.log.jsonl'
export const AGENT_LOG_KIND = 'agent-log'
export const REVIEW_LOG_KIND = 'review-log'

/** Teto generoso: log de agente real e volumoso, mas nao pode estourar memoria nem disco. */
export const DEFAULT_AGENT_LOG_MAX_BYTES = 4 * 1024 * 1024
/** Depois do desfecho, quanto ainda se espera pelo fim do stream antes de gravar o que ha. */
export const DEFAULT_AGENT_LOG_GRACE_MS = 2_000

export type AgentLogRole = 'execute' | 'review'

export interface AgentLogConfig {
  /** Teto do artefato em bytes. Acima disso o log e truncado e a truncagem fica registrada. */
  readonly maxBytes?: number
  /** Teto de espera pelo fim do stream depois que o agente terminou. */
  readonly graceMs?: number
  /** Default: mascaramento local. O composition root pode injetar outro. */
  readonly redact?: (text: string) => string
  readonly now?: () => Date
}

export interface AgentLogCaptureResult {
  /** JSONL pronto para virar artefato. Uma linha por evento, na ordem observada. */
  readonly content: string
  readonly events: number
  readonly bytes: number
  readonly truncated: boolean
  readonly droppedEvents: number
  /** O que impediu observar o log ate o fim. Presente = incidente registrado no artefato. */
  readonly problem?: string
}

export function agentLogFile(role: AgentLogRole): string {
  return role === 'review' ? REVIEW_LOG_FILE : AGENT_LOG_FILE
}

export function agentLogKind(role: AgentLogRole): string {
  return role === 'review' ? REVIEW_LOG_KIND : AGENT_LOG_KIND
}

function timestampOf(ts: AgentLogEvent['ts']): number {
  const time = ts instanceof Date ? ts.getTime() : Number.NaN
  return Number.isFinite(time) ? time : 0
}

/** Espera limitada: promessa que nunca resolve nao pode segurar a tentativa. */
function withDeadline(promise: Promise<void>, ms: number): Promise<void> {
  if (ms <= 0) return Promise.race([promise, Promise.resolve()])
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    void promise.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        resolve()
      },
    )
  })
}

function closeIterator(iterator: AsyncIterator<AgentLogEvent> | undefined): void {
  if (iterator?.return === undefined) return
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined)
  } catch {
    // Fechar o cursor e cortesia com o adapter; falhar aqui nao muda o artefato.
  }
}

/**
 * Consome `AgentHandle.logs()` em paralelo com o desfecho e acumula o JSONL da tentativa.
 *
 * Regra que sustenta a classe inteira: **nada aqui pode derrubar a tentativa**. Fonte que
 * lanca, que nunca fecha ou que devolve lixo vira nota dentro do proprio artefato
 * (ARCHITECTURE 10 — log de agente e artefato, nao caminho critico).
 */
export class AgentLogCapture {
  readonly #maxBytes: number
  readonly #graceMs: number
  readonly #redact: (text: string) => string
  readonly #now: () => Date
  readonly #lines: string[] = []
  readonly #pump: Promise<void>
  #iterator: AsyncIterator<AgentLogEvent> | undefined
  #bytes = 0
  #truncated = false
  #dropped = 0
  #stopped = false
  #done = false
  #problem: string | undefined

  constructor(open: () => AsyncIterable<AgentLogEvent>, config: AgentLogConfig = {}) {
    this.#maxBytes = Math.max(0, config.maxBytes ?? DEFAULT_AGENT_LOG_MAX_BYTES)
    this.#graceMs = Math.max(0, config.graceMs ?? DEFAULT_AGENT_LOG_GRACE_MS)
    this.#redact = config.redact ?? redactLogText
    this.#now = config.now ?? ((): Date => new Date())
    this.#pump = this.#consume(open)
  }

  /**
   * Encerra a captura e devolve o que foi observado. Espera o fim do stream ate `graceMs`;
   * passou disso, grava o parcial e registra o motivo.
   */
  async finish(): Promise<AgentLogCaptureResult> {
    await withDeadline(this.#pump, this.#graceMs)
    if (!this.#done) {
      this.#stopped = true
      this.#problem ??= `stream de log nao terminou em ${this.#graceMs}ms; gravado o parcial`
      closeIterator(this.#iterator)
    }
    return this.result()
  }

  result(): AgentLogCaptureResult {
    const lines = [...this.#lines]
    const ts = this.#now().toISOString()
    if (this.#truncated) {
      lines.push(
        JSON.stringify({
          ts,
          event: 'truncated',
          limitBytes: this.#maxBytes,
          droppedEvents: this.#dropped,
        }),
      )
    }
    if (this.#problem !== undefined) {
      lines.push(JSON.stringify({ ts, event: 'log_incomplete', detail: this.#problem }))
    }
    return {
      content: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
      events: this.#lines.length,
      bytes: this.#bytes,
      truncated: this.#truncated,
      droppedEvents: this.#dropped,
      ...(this.#problem === undefined ? {} : { problem: this.#problem }),
    }
  }

  async #consume(open: () => AsyncIterable<AgentLogEvent>): Promise<void> {
    try {
      const iterator = open()[Symbol.asyncIterator]()
      this.#iterator = iterator
      for (;;) {
        const next = await iterator.next()
        if (next.done === true || this.#stopped) break
        this.#append(next.value)
      }
    } catch (error) {
      // `logs()` que lanca e defeito do adapter, nao da tentativa: fica registrado e segue.
      this.#problem = describeError(error)
    } finally {
      this.#done = true
    }
  }

  /** Teto por acumulado: o evento que estouraria o limite e descartado, nao bufferizado. */
  #append(event: AgentLogEvent): void {
    const line = JSON.stringify({
      ts: new Date(timestampOf(event.ts)).toISOString(),
      stream: event.stream === 'stderr' ? 'stderr' : 'stdout',
      chunk: this.#redact(event.chunk),
    })
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (this.#bytes + size > this.#maxBytes) {
      this.#truncated = true
      this.#dropped += 1
      return
    }
    this.#lines.push(line)
    this.#bytes += size
  }
}

/**
 * Comeca a consumir o log do handle imediatamente. `logs()` que lanca na chamada tambem e
 * capturado aqui — por isso a fonte chega como funcao, e nao como iteravel ja aberto.
 */
export function captureAgentLog(handle: AgentHandle, config: AgentLogConfig = {}): AgentLogCapture {
  return new AgentLogCapture(() => handle.logs(), config)
}
