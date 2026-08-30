import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { DEFAULT_MAX_LINE_CHARS } from './types.js'

/** Fila de linhas de um consumidor. Cada chamada de `lines()` cria a sua. */
class LineSubscriber {
  readonly #queue: string[] = []
  #closed = false
  #wake: (() => void) | null = null
  onDone: (() => void) | null = null

  push(line: string): void {
    this.#queue.push(line)
    this.#signal()
  }

  close(): void {
    this.#closed = true
    this.#signal()
  }

  #signal(): void {
    const wake = this.#wake
    this.#wake = null
    if (wake !== null) wake()
  }

  async *iterate(): AsyncGenerator<string> {
    try {
      for (;;) {
        const next = this.#queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (this.#closed) return
        await new Promise<void>((resolve) => {
          this.#wake = resolve
        })
      }
    } finally {
      this.onDone?.()
    }
  }
}

/**
 * Consome um stream do filho ate o fim (nunca bloqueia o processo) enquanto:
 * acumula no maximo `limit` bytes em memoria, marca truncamento, alimenta o
 * digest com o conteudo COMPLETO e entrega linhas aos assinantes.
 */
export class StreamSink {
  readonly #limit: number
  readonly #maxLineChars: number
  readonly #hash = createHash('sha256')
  readonly #kept: Buffer[] = []
  readonly #replay: string[] = []
  readonly #subscribers = new Set<LineSubscriber>()
  readonly #decoder = new StringDecoder('utf8')

  #keptBytes = 0
  #replayBytes = 0
  #replayCapped = false
  #truncated = false
  #ended = false
  #partial = ''
  #text: string | null = null
  #digest: string | null = null

  constructor(limit: number, maxLineChars: number = DEFAULT_MAX_LINE_CHARS) {
    this.#limit = Math.max(0, limit)
    this.#maxLineChars = Math.max(1, maxLineChars)
  }

  get truncated(): boolean {
    return this.#truncated
  }

  push(chunk: Buffer): void {
    if (this.#ended || chunk.length === 0) return
    this.#hash.update(chunk)
    const room = this.#limit - this.#keptBytes
    if (room <= 0) {
      this.#truncated = true
    } else if (chunk.length <= room) {
      this.#kept.push(chunk)
      this.#keptBytes += chunk.length
    } else {
      this.#kept.push(chunk.subarray(0, room))
      this.#keptBytes = this.#limit
      this.#truncated = true
    }
    this.#feedLines(this.#decoder.write(chunk))
  }

  end(): void {
    if (this.#ended) return
    this.#feedLines(this.#decoder.end())
    if (this.#partial.length > 0) {
      this.#deliver(stripCarriageReturn(this.#partial))
      this.#partial = ''
    }
    this.#ended = true
    for (const subscriber of this.#subscribers) subscriber.close()
    this.#subscribers.clear()
  }

  text(): string {
    this.#text ??= Buffer.concat(this.#kept).toString('utf8')
    return this.#text
  }

  digest(): string {
    this.#digest ??= this.#hash.digest('hex')
    return this.#digest
  }

  lines(): AsyncIterable<string> {
    const subscriber = new LineSubscriber()
    for (const line of this.#replay) subscriber.push(line)
    if (this.#ended) {
      subscriber.close()
    } else {
      this.#subscribers.add(subscriber)
      subscriber.onDone = () => {
        this.#subscribers.delete(subscriber)
      }
    }
    return { [Symbol.asyncIterator]: () => subscriber.iterate() }
  }

  #feedLines(text: string): void {
    if (text.length === 0) return
    this.#partial += text
    let index = this.#partial.indexOf('\n')
    while (index !== -1) {
      this.#deliver(stripCarriageReturn(this.#partial.slice(0, index)))
      this.#partial = this.#partial.slice(index + 1)
      index = this.#partial.indexOf('\n')
    }
    // Agente que nunca quebra linha nao pode consumir a memoria do pai: o fragmento sai
    // em pedacos de tamanho fixo. Sem `\r` removido — o corte nao e fim de linha.
    while (this.#partial.length >= this.#maxLineChars) {
      this.#deliver(this.#partial.slice(0, this.#maxLineChars))
      this.#partial = this.#partial.slice(this.#maxLineChars)
    }
  }

  #deliver(line: string): void {
    if (!this.#replayCapped) {
      this.#replay.push(line)
      this.#replayBytes += line.length + 1
      if (this.#replayBytes > this.#limit) this.#replayCapped = true
    }
    for (const subscriber of this.#subscribers) subscriber.push(line)
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}
