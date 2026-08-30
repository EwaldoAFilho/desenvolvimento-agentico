import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — checker e ESM puro em .mjs, sem tipos
import { checkBoundaries, extractSpecifiers } from '../../scripts/check-boundaries.mjs'

const fixture = (name: string) => fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url))

describe('extractSpecifiers', () => {
  it('reconhece import, export-from, side-effect, dynamic e require', () => {
    const src = [
      "import a from 'x1'",
      "import { b } from 'x2'",
      "import type { C } from 'x3'",
      "export { d } from 'x4'",
      "export * from 'x5'",
      "import 'x6'",
      "const e = await import('x7')",
      "const f = require('x8')",
    ].join('\n')
    expect(new Set(extractSpecifiers(src))).toEqual(
      new Set(['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8']),
    )
  })
})

describe('checkBoundaries', () => {
  it('nao acusa nada num pacote limpo', () => {
    expect(checkBoundaries(fixture('clean'))).toEqual([])
  })

  it('reprova import de adapter dentro do dominio', () => {
    const v = checkBoundaries(fixture('dirty'))
    expect(v.some((x: { rule: string }) => x.rule === 'forbidden-import')).toBe(true)
    expect(v.find((x: { rule: string }) => x.rule === 'forbidden-import')?.detail).toContain(
      '@agentic/persistence',
    )
  })

  it('reprova modulo de plataforma dentro do dominio', () => {
    const v = checkBoundaries(fixture('dirty'))
    expect(v.some((x: { rule: string }) => x.rule === 'no-node-builtins')).toBe(true)
  })

  it('reprova nome de fornecedor dentro do dominio (P18)', () => {
    const v = checkBoundaries(fixture('dirty'))
    const hit = v.find((x: { rule: string }) => x.rule === 'no-vendor-name')
    expect(hit?.detail).toContain('claude')
  })

  it('o repositorio real respeita as fronteiras', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    expect(checkBoundaries(root)).toEqual([])
  })
})
