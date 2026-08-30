import { RUN_ID_PATTERN } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import { fixedClock } from './clock.js'
import { CROCKFORD, sequentialIds, ULID_LENGTH, ulidGenerator } from './ids.js'

const fixedRandom =
  (byte: number) =>
  (size: number): Uint8Array =>
    Uint8Array.from({ length: size }, () => byte)

describe('ulidGenerator', () => {
  it('produz id de 26 caracteres no alfabeto de Crockford', () => {
    const ids = ulidGenerator({ random: fixedRandom(0) })
    const value = ids.runId()
    expect(value).toHaveLength(ULID_LENGTH)
    for (const char of value) expect(CROCKFORD).toContain(char)
  })

  it('gera RunId valido para o dominio', () => {
    const ids = ulidGenerator()
    expect(RUN_ID_PATTERN.test(ids.runId())).toBe(true)
  })

  it('e monotonico dentro do mesmo milissegundo', () => {
    const ids = ulidGenerator({ clock: fixedClock(), random: fixedRandom(0) })
    const first = ids.runId()
    const second = ids.runId()
    const third = ids.runId()
    expect(first < second).toBe(true)
    expect(second < third).toBe(true)
  })

  it('nao repete id com a mesma fonte de aleatoriedade', () => {
    const ids = ulidGenerator({ clock: fixedClock(), random: fixedRandom(7) })
    const values = new Set([ids.runId(), ids.runId(), ids.runId(), ids.runId()])
    expect(values.size).toBe(4)
  })

  it('e reprodutivel com relogio e aleatoriedade injetados', () => {
    const build = () => ulidGenerator({ clock: fixedClock(), random: fixedRandom(3) })
    expect(build().runId()).toBe(build().runId())
  })

  it('prefixa quando pedido', () => {
    const ids = ulidGenerator({ random: fixedRandom(1) })
    expect(ids.next('gate')).toMatch(/^gate_[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('gera AttemptId aceito pelo dominio', () => {
    const ids = ulidGenerator()
    expect(ids.attemptId()).toHaveLength(ULID_LENGTH)
  })
})

describe('sequentialIds', () => {
  it('produz ids deterministicos e crescentes', () => {
    const ids = sequentialIds()
    const first = ids.runId()
    const second = ids.runId()
    expect(first < second).toBe(true)
    expect(sequentialIds().runId()).toBe(first)
  })

  it('produz RunId valido', () => {
    expect(RUN_ID_PATTERN.test(sequentialIds({ start: 42 }).runId())).toBe(true)
  })

  it('usa contador legivel no prefixo', () => {
    const ids = sequentialIds()
    expect(ids.next('review')).toBe('review_000001')
    expect(ids.next('review')).toBe('review_000002')
  })
})
