import { describe, expect, it } from 'vitest'
import { elapsedSince, formatBytes, formatDuration, formatRatio, truncate } from './format.js'

describe('formatacao', () => {
  it('duracao curta e legivel de relance', () => {
    expect(formatDuration(812)).toBe('812ms')
    expect(formatDuration(252_000)).toBe('4m12s')
    expect(formatDuration(4_020_000)).toBe('1h07m')
    expect(formatDuration(undefined)).toBe('—')
  })

  it('paralelismo usa o separador decimal do produto', () => {
    expect(formatRatio(2.4)).toBe('2,4×')
  })

  it('titulo longo e truncado sem quebrar o no', () => {
    expect(truncate('abcdef', 10)).toBe('abcdef')
    expect(truncate('abcdefghij', 5)).toBe('abcd…')
  })

  it('wall time conta a partir do inicio do run', () => {
    const started = '2026-01-08T12:10:00.000Z'
    expect(elapsedSince(started, Date.parse('2026-01-08T12:44:00.000Z'))).toBe(2_040_000)
    expect(elapsedSince(undefined, Date.now())).toBeUndefined()
  })
})

describe('formatBytes', () => {
  it('tamanho de artefato legivel, com unidade', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(18_442)).toBe('18,0 kB')
    expect(formatBytes(4 * 1024 * 1024)).toBe('4,0 MB')
  })

  it('sem tamanho medido, nao inventa numero', () => {
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
  })
})
