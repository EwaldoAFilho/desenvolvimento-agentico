import assert from 'node:assert/strict'

export const alvo = 'texto.js'

/** Modulo base: existe antes da missao. Sumir daqui e falha, nunca pendencia. */
export const base = true

export function casos(modulo) {
  const { normalizar, semEspacos } = modulo
  return [
    {
      nome: 'normalizar apara, baixa a caixa e colapsa espaco',
      executar: () => {
        assert.equal(normalizar('  2H   15M '), '2h 15m')
      },
    },
    {
      nome: 'normalizar devolve vazio para nao-string',
      executar: () => {
        assert.equal(normalizar(undefined), '')
        assert.equal(normalizar(null), '')
        assert.equal(normalizar(42), '')
      },
    },
    {
      nome: 'semEspacos remove todo espaco interno',
      executar: () => {
        assert.equal(semEspacos(' 08:00 - 12:30 '), '08:00-12:30')
      },
    },
  ]
}
