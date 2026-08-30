import { randomBytes } from 'node:crypto'
import {
  type AttemptId,
  type Clock,
  type IdGenerator,
  type RunId,
  attemptId as toAttemptId,
  runId as toRunId,
} from '@agentic/domain'

/** Crockford base32: o alfabeto do ULID, sem I, L, O e U. */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const ULID_LENGTH = 26
const TIME_CHARS = 10
const RANDOM_CHARS = 16
const MAX_TIME = 0xffffffffffff

/** Fonte de aleatoriedade injetavel: no caminho deterministico de teste nao ha `Math.random`. */
export type RandomSource = (size: number) => Uint8Array

export interface UlidGeneratorOptions {
  readonly clock?: Clock
  readonly random?: RandomSource
}

function encodeTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_TIME) {
    throw new RangeError(`instante fora da faixa de um ULID: ${ms}`)
  }
  let rest = Math.floor(ms)
  const out: string[] = []
  for (let i = 0; i < TIME_CHARS; i += 1) {
    out.push(CROCKFORD.charAt(rest % 32))
    rest = Math.floor(rest / 32)
  }
  return out.reverse().join('')
}

function drawRandom(random: RandomSource): number[] {
  const bytes = random(RANDOM_CHARS)
  const out: number[] = []
  for (let i = 0; i < RANDOM_CHARS; i += 1) out.push((bytes[i] ?? 0) % 32)
  return out
}

/** Mesmo milissegundo: incrementa o sufixo em vez de sortear de novo (monotonicidade). */
function increment(values: number[]): void {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const next = (values[i] ?? 0) + 1
    if (next < 32) {
      values[i] = next
      return
    }
    values[i] = 0
  }
  throw new RangeError('sufixo aleatorio do ULID esgotado no mesmo milissegundo')
}

/**
 * ULID monotonico. Duas chamadas no mesmo milissegundo continuam ordenadas, e a fonte de
 * aleatoriedade e parametro: um teste injeta uma sequencia fixa e obtem ids reprodutiveis.
 */
export function ulidGenerator(options: UlidGeneratorOptions = {}): IdGenerator {
  const random = options.random ?? ((size: number): Uint8Array => randomBytes(size))
  const now = (): number =>
    options.clock === undefined ? Date.now() : options.clock.now().getTime()
  let lastTime = -1
  let suffix = drawRandom(random)

  const ulid = (): string => {
    const time = now()
    if (time === lastTime) increment(suffix)
    else {
      lastTime = time
      suffix = drawRandom(random)
    }
    const tail = suffix.map((value) => CROCKFORD.charAt(value)).join('')
    return `${encodeTime(time)}${tail}`
  }

  return {
    runId: (): RunId => toRunId(ulid()),
    attemptId: (): AttemptId => toAttemptId(ulid()),
    next: (prefix?: string): string => (prefix === undefined ? ulid() : `${prefix}_${ulid()}`),
  }
}

export interface SequentialIdsOptions {
  readonly start?: number
}

function encodeCounter(value: number): string {
  let rest = value
  let out = ''
  do {
    out = CROCKFORD.charAt(rest % 32) + out
    rest = Math.floor(rest / 32)
  } while (rest > 0)
  return out.padStart(ULID_LENGTH, '0')
}

/** Ids deterministicos para teste: nenhuma aleatoriedade, nenhum relogio. */
export function sequentialIds(options: SequentialIdsOptions = {}): IdGenerator {
  let counter = options.start ?? 1
  const nextValue = (): number => {
    const value = counter
    counter += 1
    return value
  }
  return {
    runId: (): RunId => toRunId(encodeCounter(nextValue())),
    attemptId: (): AttemptId => toAttemptId(encodeCounter(nextValue())),
    next: (prefix?: string): string => {
      const value = nextValue()
      return prefix === undefined
        ? encodeCounter(value)
        : `${prefix}_${String(value).padStart(6, '0')}`
    },
  }
}
