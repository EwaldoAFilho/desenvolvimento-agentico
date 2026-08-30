import assert from 'node:assert/strict'

export const alvo = 'resultado.js'

/** Modulo base: existe antes da missao. Sumir daqui e falha, nunca pendencia. */
export const base = true

export function casos(modulo) {
  const { CODIGOS, falha, ok, propagar } = modulo
  return [
    {
      nome: 'ok carrega o valor',
      executar: () => {
        assert.deepEqual(ok(7), { ok: true, valor: 7 })
      },
    },
    {
      nome: 'falha carrega codigo e mensagem',
      executar: () => {
        const r = falha(CODIGOS.FORMATO, 'x')
        assert.equal(r.ok, false)
        assert.equal(r.codigo, 'FORMATO')
        assert.equal(r.mensagem, 'x')
      },
    },
    {
      nome: 'codigo inventado e erro de programacao',
      executar: () => {
        assert.throws(() => falha('INVALIDO', 'x'), TypeError)
      },
    },
    {
      nome: 'propagar preserva o codigo da causa',
      executar: () => {
        const causa = falha(CODIGOS.FAIXA, 'hora fora de 00..23')
        const r = propagar(causa, 'inicio')
        assert.equal(r.codigo, 'FAIXA')
        assert.match(r.mensagem, /^inicio: /)
      },
    },
    {
      nome: 'os quatro codigos existem',
      executar: () => {
        assert.deepEqual(Object.keys(CODIGOS).sort(), ['FAIXA', 'FORMATO', 'ORDEM', 'VAZIO'])
      },
    },
  ]
}
