import nodeProcess from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { buildEnv } from './env.js'

describe('buildEnv', () => {
  const injected = ['AG_TEST_ALLOWED', 'AG_TEST_SECRET']

  afterEach(() => {
    for (const key of injected) delete nodeProcess.env[key]
  })

  it('deixa passar apenas as chaves da allowlist', () => {
    const source = { KEEP: 'yes', DROP: 'no', ALSO_DROP: 'no' }
    expect(buildEnv(['KEEP'], source)).toEqual({ KEEP: 'yes' })
  })

  it('omite chave ausente na origem em vez de criar undefined', () => {
    const result = buildEnv(['PRESENT', 'MISSING'], { PRESENT: 'x' })
    expect(result).toEqual({ PRESENT: 'x' })
    expect(Object.hasOwn(result, 'MISSING')).toBe(false)
  })

  it('allowlist vazia produz ambiente vazio', () => {
    expect(buildEnv([], { A: '1', B: '2' })).toEqual({})
  })

  it('nunca copia o ambiente inteiro', () => {
    const source: NodeJS.ProcessEnv = {}
    for (let i = 0; i < 50; i += 1) source[`VAR_${i}`] = String(i)
    expect(Object.keys(buildEnv(['VAR_7'], source))).toEqual(['VAR_7'])
  })

  it('usa process.env como origem padrao', () => {
    nodeProcess.env.AG_TEST_ALLOWED = 'visivel'
    nodeProcess.env.AG_TEST_SECRET = 'invisivel'
    expect(buildEnv(['AG_TEST_ALLOWED'])).toEqual({ AG_TEST_ALLOWED: 'visivel' })
  })

  it('preserva valor vazio e ignora repeticao de chave', () => {
    expect(buildEnv(['EMPTY', 'EMPTY'], { EMPTY: '' })).toEqual({ EMPTY: '' })
  })

  it('devolve objeto novo, sem alias para a origem', () => {
    const source = { A: '1' }
    const result = buildEnv(['A'], source)
    result.A = '2'
    expect(source.A).toBe('1')
  })
})
