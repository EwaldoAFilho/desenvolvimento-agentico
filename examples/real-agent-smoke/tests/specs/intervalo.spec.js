import assert from 'node:assert/strict'

/**
 * Contrato de `src/intervalo.js` — entregue pela task T02.
 * Enquanto o arquivo nao existir, a suite marca este spec como PENDENTE.
 */
export const alvo = 'intervalo.js'

export function casos(modulo) {
  const { analisarIntervalo } = modulo
  return [
    {
      nome: 'exporta analisarIntervalo',
      executar: () => {
        assert.equal(typeof analisarIntervalo, 'function')
      },
    },
    {
      nome: 'devolve inicio e fim em minutos',
      executar: () => {
        assert.deepEqual(analisarIntervalo('08:00-12:30'), {
          ok: true,
          valor: { inicio: 480, fim: 750 },
        })
        assert.deepEqual(analisarIntervalo(' 08:00 - 12:30 '), {
          ok: true,
          valor: { inicio: 480, fim: 750 },
        })
        assert.deepEqual(analisarIntervalo('00:00-23:59'), {
          ok: true,
          valor: { inicio: 0, fim: 1439 },
        })
      },
    },
    {
      nome: 'entrada ausente e VAZIO',
      executar: () => {
        assert.equal(analisarIntervalo('').codigo, 'VAZIO')
        assert.equal(analisarIntervalo('   ').codigo, 'VAZIO')
        assert.equal(analisarIntervalo(undefined).codigo, 'VAZIO')
      },
    },
    {
      nome: 'separador ausente ou repetido e FORMATO',
      executar: () => {
        assert.equal(analisarIntervalo('08:00').codigo, 'FORMATO')
        assert.equal(analisarIntervalo('08:00-12:30-14:00').codigo, 'FORMATO')
      },
    },
    {
      nome: 'lado vazio propaga VAZIO',
      executar: () => {
        assert.equal(analisarIntervalo('-12:30').codigo, 'VAZIO')
        assert.equal(analisarIntervalo('08:00-').codigo, 'VAZIO')
      },
    },
    {
      nome: 'lado mal formado propaga FORMATO',
      executar: () => {
        assert.equal(analisarIntervalo('8:00-12:30').codigo, 'FORMATO')
        assert.equal(analisarIntervalo('08:00-12h30').codigo, 'FORMATO')
      },
    },
    {
      nome: 'lado fora da faixa propaga FAIXA',
      executar: () => {
        assert.equal(analisarIntervalo('25:00-26:00').codigo, 'FAIXA')
        assert.equal(analisarIntervalo('08:00-12:75').codigo, 'FAIXA')
      },
    },
    {
      nome: 'fim que nao passa do inicio e ORDEM',
      executar: () => {
        assert.equal(analisarIntervalo('12:30-08:00').codigo, 'ORDEM')
        assert.equal(analisarIntervalo('08:00-08:00').codigo, 'ORDEM')
      },
    },
  ]
}
