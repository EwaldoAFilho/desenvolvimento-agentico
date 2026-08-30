import assert from 'node:assert/strict'

/**
 * Contrato de `src/duracao.js` — entregue pela task T01.
 * Enquanto o arquivo nao existir, a suite marca este spec como PENDENTE.
 */
export const alvo = 'duracao.js'

export function casos(modulo) {
  const { analisarDuracao } = modulo
  return [
    {
      nome: 'exporta analisarDuracao',
      executar: () => {
        assert.equal(typeof analisarDuracao, 'function')
      },
    },
    {
      nome: 'hora e minuto juntos',
      executar: () => {
        assert.deepEqual(analisarDuracao('1h30m'), { ok: true, valor: 90 })
        assert.deepEqual(analisarDuracao('01h05m'), { ok: true, valor: 65 })
        assert.deepEqual(analisarDuracao('23h59m'), { ok: true, valor: 1439 })
      },
    },
    {
      nome: 'so hora ou so minuto',
      executar: () => {
        assert.deepEqual(analisarDuracao('2h'), { ok: true, valor: 120 })
        assert.deepEqual(analisarDuracao('45m'), { ok: true, valor: 45 })
        assert.deepEqual(analisarDuracao('1h0m'), { ok: true, valor: 60 })
      },
    },
    {
      nome: 'caixa e espaco nao importam',
      executar: () => {
        assert.deepEqual(analisarDuracao('  2H 15M '), { ok: true, valor: 135 })
      },
    },
    {
      nome: 'entrada ausente e VAZIO',
      executar: () => {
        assert.equal(analisarDuracao('').codigo, 'VAZIO')
        assert.equal(analisarDuracao('   ').codigo, 'VAZIO')
        assert.equal(analisarDuracao(undefined).codigo, 'VAZIO')
        assert.equal(analisarDuracao(90).codigo, 'VAZIO')
      },
    },
    {
      nome: 'numero sem unidade e FORMATO',
      executar: () => {
        assert.equal(analisarDuracao('30').codigo, 'FORMATO')
        assert.equal(analisarDuracao('1h30').codigo, 'FORMATO')
      },
    },
    {
      nome: 'unidade sem numero e FORMATO',
      executar: () => {
        assert.equal(analisarDuracao('h').codigo, 'FORMATO')
        assert.equal(analisarDuracao('m').codigo, 'FORMATO')
        assert.equal(analisarDuracao('abc').codigo, 'FORMATO')
      },
    },
    {
      nome: 'ordem invertida e FORMATO',
      executar: () => {
        assert.equal(analisarDuracao('30m1h').codigo, 'FORMATO')
      },
    },
    {
      nome: 'componente fora da faixa e FAIXA',
      executar: () => {
        assert.equal(analisarDuracao('1h60m').codigo, 'FAIXA')
        assert.equal(analisarDuracao('24h').codigo, 'FAIXA')
      },
    },
    {
      nome: 'duracao zero e FAIXA',
      executar: () => {
        assert.equal(analisarDuracao('0m').codigo, 'FAIXA')
        assert.equal(analisarDuracao('0h0m').codigo, 'FAIXA')
      },
    },
  ]
}
